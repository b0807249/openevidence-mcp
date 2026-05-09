#!/usr/bin/env python3
"""Sync OpenEvidence chat history + collections into a local SQLite mirror.

Subcommands
-----------
  init             Create the database and schema (idempotent).
  sync-history     Paginate /api/article/list and upsert chats. Incremental
                   by default — stops at the first page where every
                   article_id is already known. --full forces a complete
                   walk; --pages N caps at N pages.
  sync-collections List /api/collections/collections and re-pull membership
                   for each. Prunes collections + memberships that the
                   server no longer reports.
  list-unsorted    Print chats with no membership in any collection whose
                   name starts with '#'. --json emits a structured object
                   (unsorted_count, shown, items[]) suitable for piping
                   into the routine.
  summary          Print counts + last sync timestamps as JSON.

Authentication uses cookies.json exported from the browser (same file the TS
MCP server uses). DataDome is handled by the shared `_oe_session.OESession`.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _oe_session import OESession  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_COOKIES = ROOT / "cookies.json"
HOME_DEFAULT_DB = Path.home() / ".openevidence-mcp" / "db" / "oe.sqlite"

API_HISTORY = "https://www.openevidence.com/api/article/list"
API_COLLECTIONS = "https://www.openevidence.com/api/collections/collections"

SCHEMA_VERSION = "1"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS chats (
  article_id        TEXT PRIMARY KEY,
  title             TEXT,
  question          TEXT,
  article_type      TEXT,
  status            TEXT,
  access_level      TEXT,
  voice_mode        INTEGER,
  dotflow_id        TEXT,
  dotflow_name      TEXT,
  parent_thread_json TEXT,
  attachments_json  TEXT,
  datetime_created  TEXT,
  raw_json          TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_dt ON chats(datetime_created DESC);

CREATE TABLE IF NOT EXISTS collections (
  collection_id     TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  is_hashtag        INTEGER NOT NULL,
  access_level      TEXT,
  owner_id          TEXT,
  article_count     INTEGER,
  created_at        TEXT,
  updated_at        TEXT,
  raw_json          TEXT,
  last_seen_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS collections_hashtag ON collections(is_hashtag, name);

-- added_at is left NULL when the row is reconstructed from the collection
-- detail GET (questions[] only carries the chat's own datetime_created).
-- The exact membership-added timestamp would require an extra GET per row.
CREATE TABLE IF NOT EXISTS memberships (
  collection_id     TEXT NOT NULL,
  article_id        TEXT NOT NULL,
  added_at          TEXT,
  last_seen_at      TEXT NOT NULL,
  PRIMARY KEY (collection_id, article_id)
);
CREATE INDEX IF NOT EXISTS memberships_article ON memberships(article_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def resolve_db_path(args: argparse.Namespace) -> Path:
    if args.db:
        return args.db
    env = os.environ.get("OE_MCP_DB_PATH")
    if env:
        return Path(env).expanduser()
    return HOME_DEFAULT_DB


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA_SQL)
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (SCHEMA_VERSION,),
    )
    conn.commit()
    return conn


def make_session(args: argparse.Namespace) -> OESession:
    if not args.cookies.exists():
        raise SystemExit(f"cookies file not found: {args.cookies}")
    return OESession(
        args.cookies,
        min_interval=args.rate,
        max_retries=args.retries,
        verbose=args.verbose,
    )


# ---------- init ----------

def cmd_init(args: argparse.Namespace) -> int:
    db_path = resolve_db_path(args)
    conn = open_db(db_path)
    conn.close()
    print(f"db ready: {db_path}")
    return 0


# ---------- sync-history ----------

def upsert_chat(conn: sqlite3.Connection, row: dict, ts: str) -> bool:
    """Returns True when this article_id was previously unseen."""
    aid = row.get("id")
    if not aid:
        return False
    inputs = row.get("inputs") or {}
    existing = conn.execute(
        "SELECT 1 FROM chats WHERE article_id=?", (aid,)
    ).fetchone() is not None
    conn.execute(
        """
        INSERT INTO chats (
          article_id, title, question, article_type, status, access_level,
          voice_mode, dotflow_id, dotflow_name, parent_thread_json,
          attachments_json, datetime_created, raw_json,
          first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(article_id) DO UPDATE SET
          title=excluded.title,
          question=excluded.question,
          article_type=excluded.article_type,
          status=excluded.status,
          access_level=excluded.access_level,
          voice_mode=excluded.voice_mode,
          dotflow_id=excluded.dotflow_id,
          dotflow_name=excluded.dotflow_name,
          parent_thread_json=excluded.parent_thread_json,
          attachments_json=excluded.attachments_json,
          datetime_created=excluded.datetime_created,
          raw_json=excluded.raw_json,
          last_seen_at=excluded.last_seen_at
        """,
        (
            aid,
            row.get("title"),
            inputs.get("question"),
            row.get("article_type"),
            row.get("status"),
            row.get("access_level"),
            1 if row.get("voice_mode") else 0,
            row.get("dotflow_id"),
            row.get("dotflow_name"),
            json.dumps(inputs.get("history") or [], ensure_ascii=False),
            json.dumps(inputs.get("attachments") or [], ensure_ascii=False),
            row.get("datetime_created"),
            json.dumps(row, ensure_ascii=False),
            ts,
            ts,
        ),
    )
    return not existing


def cmd_sync_history(args: argparse.Namespace) -> int:
    db_path = resolve_db_path(args)
    conn = open_db(db_path)
    sess = make_session(args)
    ts = now_iso()
    limit = args.page_size
    offset = 0
    pages = 0
    new_total = 0
    seen_total = 0
    while True:
        url = f"{API_HISTORY}?limit={limit}&offset={offset}&search=&tags="
        status, payload = sess.request("GET", url)
        if status != 200 or not isinstance(payload, dict):
            print(f"history page failed: HTTP {status} {payload}", file=sys.stderr)
            conn.close()
            return 2
        results = payload.get("results") or []
        if not results:
            break
        new_in_page = 0
        for r in results:
            if upsert_chat(conn, r, ts):
                new_in_page += 1
        conn.commit()
        new_total += new_in_page
        seen_total += len(results)
        pages += 1
        if args.verbose:
            print(f"  page {pages}: +{new_in_page}/{len(results)} (offset {offset})")
        if not payload.get("next"):
            break
        if args.pages and pages >= args.pages:
            break
        if not args.full and new_in_page == 0:
            if args.verbose:
                print("  incremental stop: page had no new ids")
            break
        offset += limit
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('last_history_sync_at', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (ts,),
    )
    conn.commit()
    conn.close()
    print(f"sync-history: {pages} pages, {seen_total} rows scanned, {new_total} new chats")
    return 0


# ---------- sync-collections ----------

def upsert_collection(conn: sqlite3.Connection, row: dict, ts: str) -> None:
    name = row.get("name") or ""
    conn.execute(
        """
        INSERT INTO collections (
          collection_id, name, description, is_hashtag, access_level,
          owner_id, article_count, created_at, updated_at, raw_json, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(collection_id) DO UPDATE SET
          name=excluded.name,
          description=excluded.description,
          is_hashtag=excluded.is_hashtag,
          access_level=excluded.access_level,
          owner_id=excluded.owner_id,
          article_count=excluded.article_count,
          created_at=excluded.created_at,
          updated_at=excluded.updated_at,
          raw_json=excluded.raw_json,
          last_seen_at=excluded.last_seen_at
        """,
        (
            row.get("id"),
            name,
            row.get("description"),
            1 if name.startswith("#") else 0,
            row.get("access_level"),
            row.get("owner_id"),
            row.get("article_count"),
            row.get("created_at"),
            row.get("updated_at"),
            json.dumps(row, ensure_ascii=False),
            ts,
        ),
    )


def replace_memberships(conn: sqlite3.Connection, collection_id: str,
                         questions: list[dict], ts: str) -> None:
    seen_aids: list[str] = []
    for q in questions or []:
        aid = q.get("id")
        if not aid:
            continue
        seen_aids.append(aid)
        conn.execute(
            """
            INSERT INTO memberships (collection_id, article_id, added_at, last_seen_at)
            VALUES (?, ?, NULL, ?)
            ON CONFLICT(collection_id, article_id) DO UPDATE SET
              last_seen_at=excluded.last_seen_at
            """,
            (collection_id, aid, ts),
        )
    if seen_aids:
        placeholders = ",".join("?" for _ in seen_aids)
        conn.execute(
            f"DELETE FROM memberships WHERE collection_id=? AND article_id NOT IN ({placeholders})",
            (collection_id, *seen_aids),
        )
    else:
        conn.execute("DELETE FROM memberships WHERE collection_id=?", (collection_id,))


def cmd_sync_collections(args: argparse.Namespace) -> int:
    db_path = resolve_db_path(args)
    conn = open_db(db_path)
    sess = make_session(args)
    ts = now_iso()
    status, payload = sess.request("GET", API_COLLECTIONS)
    if status != 200 or not isinstance(payload, list):
        print(f"list collections failed: HTTP {status} {payload}", file=sys.stderr)
        conn.close()
        return 2
    seen_cids: list[str] = []
    for col in payload:
        cid = col.get("id")
        if not cid:
            continue
        seen_cids.append(cid)
        upsert_collection(conn, col, ts)
    conn.commit()
    for cid in seen_cids:
        status, detail = sess.request("GET", f"{API_COLLECTIONS}/{cid}")
        if status != 200 or not isinstance(detail, dict):
            print(f"  warn: GET {cid} failed (HTTP {status})", file=sys.stderr)
            continue
        upsert_collection(conn, detail, ts)
        replace_memberships(conn, cid, detail.get("questions") or [], ts)
        conn.commit()
    if seen_cids:
        placeholders = ",".join("?" for _ in seen_cids)
        conn.execute(
            f"DELETE FROM memberships WHERE collection_id NOT IN ({placeholders})",
            seen_cids,
        )
        conn.execute(
            f"DELETE FROM collections WHERE collection_id NOT IN ({placeholders})",
            seen_cids,
        )
    else:
        conn.execute("DELETE FROM memberships")
        conn.execute("DELETE FROM collections")
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('last_collections_sync_at', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (ts,),
    )
    conn.commit()
    n_total = conn.execute("SELECT COUNT(*) FROM collections").fetchone()[0]
    n_hash = conn.execute("SELECT COUNT(*) FROM collections WHERE is_hashtag=1").fetchone()[0]
    n_mem = conn.execute("SELECT COUNT(*) FROM memberships").fetchone()[0]
    conn.close()
    print(f"sync-collections: {n_total} collections ({n_hash} hashtag), {n_mem} memberships")
    return 0


# ---------- list-unsorted ----------

UNSORTED_SQL = """
SELECT c.article_id, c.title, c.question, c.datetime_created
FROM chats c
WHERE c.article_id NOT IN (
  SELECT m.article_id FROM memberships m
  JOIN collections col ON col.collection_id = m.collection_id
  WHERE col.is_hashtag = 1
)
ORDER BY c.datetime_created DESC
LIMIT ?
"""

UNSORTED_COUNT_SQL = """
SELECT COUNT(*) FROM chats c
WHERE c.article_id NOT IN (
  SELECT m.article_id FROM memberships m
  JOIN collections col ON col.collection_id = m.collection_id
  WHERE col.is_hashtag = 1
)
"""


def cmd_list_unsorted(args: argparse.Namespace) -> int:
    db_path = resolve_db_path(args)
    conn = open_db(db_path)
    rows = conn.execute(UNSORTED_SQL, (args.limit,)).fetchall()
    total = conn.execute(UNSORTED_COUNT_SQL).fetchone()[0]
    if args.json:
        out = {
            "unsorted_count": total,
            "shown": len(rows),
            "items": [
                {
                    "article_id": r[0],
                    "title": r[1],
                    "question_preview": (r[2] or "")[: args.preview_chars],
                    "datetime_created": r[3],
                }
                for r in rows
            ],
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        for r in rows:
            title = r[1] or "(no title)"
            qp = (r[2] or "").replace("\n", " ")[:80]
            day = r[3][:10] if r[3] else "----------"
            print(f"  {day}  {r[0]}  {title!s:40}  {qp!r}")
        print(f"shown {len(rows)}; total unsorted {total}", file=sys.stderr)
    conn.close()
    return 0


# ---------- ensure-collection ----------

def fetch_collections_by_name(sess: OESession) -> dict[str, dict]:
    status, payload = sess.request("GET", API_COLLECTIONS)
    if status != 200 or not isinstance(payload, list):
        raise RuntimeError(f"list collections failed: HTTP {status} {payload}")
    return {c.get("name"): c for c in payload if c.get("name")}


def ensure_collection(sess: OESession, name: str, description: str = "") -> dict:
    by_name = fetch_collections_by_name(sess)
    if name in by_name:
        return by_name[name]
    if not name.startswith("#"):
        raise SystemExit(f"refusing to mint non-hashtag collection: {name!r}")
    status, payload = sess.request(
        "POST", API_COLLECTIONS, body={"name": name, "description": description}
    )
    if status not in (200, 201) or not isinstance(payload, dict):
        raise RuntimeError(f"create collection {name!r} failed: HTTP {status} {payload}")
    return payload


def cmd_ensure_collection(args: argparse.Namespace) -> int:
    sess = make_session(args)
    col = ensure_collection(sess, args.name, args.description or "")
    print(json.dumps(col, ensure_ascii=False, indent=2))
    return 0


# ---------- bulk-apply ----------

def cmd_bulk_apply(args: argparse.Namespace) -> int:
    """Apply a plan: [{"article_id": "...", "hashtags": ["#dlbcl", ...]}, ...]"""
    db_path = resolve_db_path(args)
    conn = open_db(db_path)
    plan = json.loads(args.plan.read_text())
    if not isinstance(plan, list):
        print("plan must be a JSON array", file=sys.stderr)
        return 2

    # Validate: every hashtag must start with '#'
    for entry in plan:
        for h in entry.get("hashtags") or []:
            if not h.startswith("#"):
                print(f"refusing non-hashtag tag {h!r} in plan", file=sys.stderr)
                return 2

    sess = make_session(args)
    by_name = fetch_collections_by_name(sess)

    # Mint missing hashtag collections.
    needed_tags = sorted({h for e in plan for h in (e.get("hashtags") or [])})
    descriptions = json.loads(args.descriptions.read_text()) if args.descriptions else {}
    for tag in needed_tags:
        if tag in by_name:
            continue
        desc = descriptions.get(tag, "")
        print(f"  + creating {tag} ...")
        col = ensure_collection(sess, tag, desc)
        by_name[tag] = col

    # Build a set of (collection_id, article_id) pairs already in our DB so
    # we skip redundant POSTs (lighter on the API + idempotent).
    existing = {
        (cid, aid)
        for cid, aid in conn.execute(
            "SELECT collection_id, article_id FROM memberships"
        ).fetchall()
    }

    n_planned = sum(len(e.get("hashtags") or []) for e in plan)
    n_skipped_known = 0
    n_added = 0
    n_failed = 0
    for entry in plan:
        aid = entry.get("article_id")
        if not aid:
            continue
        for tag in entry.get("hashtags") or []:
            cid = by_name[tag].get("id")
            if (cid, aid) in existing:
                n_skipped_known += 1
                continue
            url = f"{API_COLLECTIONS}/{cid}/add_article"
            status, payload = sess.request("POST", url, body={"article_id": aid})
            if status in (200, 201):
                n_added += 1
                if args.verbose:
                    print(f"  +{tag} {aid}")
            elif status == 400 and isinstance(payload, dict) and "already" in str(payload).lower():
                # Server-side dedup; treat as success.
                n_skipped_known += 1
            else:
                n_failed += 1
                print(f"  FAILED {tag} {aid}: HTTP {status} {payload}", file=sys.stderr)
    print(
        f"bulk-apply: planned={n_planned} added={n_added} "
        f"skipped_known={n_skipped_known} failed={n_failed}"
    )
    conn.close()
    return 0 if n_failed == 0 else 3


# ---------- summary ----------

def cmd_summary(args: argparse.Namespace) -> int:
    db_path = resolve_db_path(args)
    conn = open_db(db_path)
    chats = conn.execute("SELECT COUNT(*) FROM chats").fetchone()[0]
    cols = conn.execute("SELECT COUNT(*) FROM collections").fetchone()[0]
    hash_cols = conn.execute("SELECT COUNT(*) FROM collections WHERE is_hashtag=1").fetchone()[0]
    mem = conn.execute("SELECT COUNT(*) FROM memberships").fetchone()[0]
    unsorted = conn.execute(UNSORTED_COUNT_SQL).fetchone()[0]
    last_h = conn.execute("SELECT value FROM meta WHERE key='last_history_sync_at'").fetchone()
    last_c = conn.execute("SELECT value FROM meta WHERE key='last_collections_sync_at'").fetchone()
    out = {
        "db_path": str(resolve_db_path(args)),
        "chats": chats,
        "collections_total": cols,
        "collections_hashtag": hash_cols,
        "memberships": mem,
        "unsorted_chats": unsorted,
        "last_history_sync_at": last_h[0] if last_h else None,
        "last_collections_sync_at": last_c[0] if last_c else None,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    conn.close()
    return 0


# ---------- entrypoint ----------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cookies", type=Path, default=DEFAULT_COOKIES)
    ap.add_argument("--db", type=Path, default=None,
                    help=f"SQLite path (default: $OE_MCP_DB_PATH or {HOME_DEFAULT_DB})")
    ap.add_argument("--rate", type=float, default=1.0,
                    help="Min seconds between requests (default: 1.0).")
    ap.add_argument("--retries", type=int, default=4,
                    help="Max retries on connection reset / 5xx / 429.")
    ap.add_argument("--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init", help="Create the SQLite database and schema (idempotent).")
    s.set_defaults(func=cmd_init)

    s = sub.add_parser("sync-history", help="Pull /api/article/list into chats.")
    s.add_argument("--full", action="store_true",
                   help="Walk all pages; do not stop on the first all-known page.")
    s.add_argument("--pages", type=int, default=None,
                   help="Cap pages walked (default: unlimited).")
    s.add_argument("--page-size", type=int, default=20)
    s.set_defaults(func=cmd_sync_history)

    s = sub.add_parser("sync-collections",
                       help="Refresh collections + memberships from API.")
    s.set_defaults(func=cmd_sync_collections)

    s = sub.add_parser("list-unsorted",
                       help="Chats with no membership in any '#'-prefixed collection.")
    s.add_argument("--limit", type=int, default=200)
    s.add_argument("--preview-chars", type=int, default=240)
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_list_unsorted)

    s = sub.add_parser("ensure-collection",
                       help="Create the named collection if absent. Refuses non-'#' names.")
    s.add_argument("--name", required=True)
    s.add_argument("--description", default="")
    s.set_defaults(func=cmd_ensure_collection)

    s = sub.add_parser("bulk-apply",
                       help="Apply a plan.json: [{article_id, hashtags:[…]}, …]. "
                            "Mints missing '#'-collections and adds memberships.")
    s.add_argument("plan", type=Path)
    s.add_argument("--descriptions", type=Path, default=None,
                   help="Optional JSON {hashtag: description} for newly-minted collections.")
    s.set_defaults(func=cmd_bulk_apply)

    s = sub.add_parser("summary", help="Counts + last sync timestamps as JSON.")
    s.set_defaults(func=cmd_summary)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
