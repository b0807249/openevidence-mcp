#!/usr/bin/env python3
"""Hybrid auto-classifier for unsorted chats.

Two signals, OR'd together:
  1. Curated keyword rules (transparent; edit by reading the source).
  2. Statistical learning: per-tag log-odds-ratio with informative-Dirichlet
     prior (Monroe et al. 2008) computed from the 600+ memberships you have
     already accepted. The signatures rebuild on every run, so as you
     correct mistakes the model adapts.

Subcommands
-----------
  classify    Read unsorted chats from SQLite and write a plan
              [{"article_id": ..., "hashtags": [...]}] to --output.
              --reclassify-all ignores current memberships and predicts for
              every chat (use for dry-run audits).
  validate    Held-out cross-validation against current memberships.
              For each chat in tag T, hide T and check whether the model
              re-predicts T. Reports per-tag precision/recall.

Both subcommands refuse to mint new tags — they pick only from collections
already present in the local DB whose name starts with '#'. New topics fall
through to '#misc'. Bring agent judgment to the table for fresh categories.
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import os
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOME_DEFAULT_DB = Path.home() / ".openevidence-mcp" / "db" / "oe.sqlite"

STOPWORDS = {
    "the", "and", "for", "with", "are", "was", "were", "this", "that", "these",
    "those", "have", "has", "had", "been", "being", "from", "into", "onto",
    "about", "above", "below", "after", "before", "where", "when", "why",
    "how", "what", "which", "who", "whom", "whose", "all", "any", "some",
    "many", "much", "more", "most", "other", "only", "just", "also", "like",
    "but", "not", "can", "could", "should", "would", "may", "might", "must",
    "will", "shall", "they", "them", "their", "there", "here", "his", "her",
    "she", "him", "you", "your", "yours", "ours", "our", "its", "use", "used",
    "uses", "make", "made", "see", "give", "given", "take", "taken", "get",
    "got", "going", "still", "even", "such", "than", "then", "very", "well",
    "between", "among", "each", "every", "both", "either", "neither", "while",
    "during", "without", "within", "across", "through", "over", "under",
    "around", "into", "out", "off", "down", "back", "yet", "now", "later",
    "again", "ever", "never", "always", "often", "sometimes", "usually",
    "case", "cases", "patient", "patients", "treatment", "patient's",
    # Heavily oncology-specific common words that don't separate tags well
    "cancer", "tumor", "tumour", "trial", "trials", "study", "studies",
}

CJK_RE = re.compile(r"[一-鿿]+")
WORD_RE = re.compile(r"[a-z][a-z0-9\-]+")


def tokenize(text: str) -> list[str]:
    """Lowercase English words ≥3 chars + Chinese 2-grams. Stopwords dropped."""
    if not text:
        return []
    text = text.lower()
    en = [w for w in WORD_RE.findall(text) if len(w) >= 3 and w not in STOPWORDS]
    cj: list[str] = []
    for run in CJK_RE.findall(text):
        for i in range(len(run) - 1):
            cj.append(run[i : i + 2])
    return en + cj


def chat_text(title: str | None, question: str | None, parent_thread_json: str | None) -> str:
    parts: list[str] = [title or "", question or ""]
    if parent_thread_json:
        try:
            history = json.loads(parent_thread_json)
            for h in history or []:
                parts.append(str(h.get("title") or ""))
                parts.append(str(h.get("input") or ""))
        except json.JSONDecodeError:
            pass
    return " ".join(parts)


# ----------------------------- keyword rules -----------------------------

def has(blob: str, *needles: str) -> bool:
    return any(n in blob for n in needles)


def has_word(blob: str, *needles: str) -> bool:
    for n in needles:
        if re.search(rf"(?<![a-z0-9]){re.escape(n)}(?![a-z0-9])", blob):
            return True
    return False


def apply_rules(title: str, body: str) -> set[str]:
    t = (title or "").lower()
    q = (body or "").lower()
    blob = f"{t}\n{q}"
    tags: set[str] = set()

    # --- heme: lymphomas ---
    is_dlbcl = has_word(blob, "dlbcl") or has(blob, "diffuse large b", "double-hit")
    if is_dlbcl:
        tags.add("#DLBCL")
    if (has_word(blob, "fl", "mcl", "mzl", "pcnsl", "hl")
            or has(blob, "follicular lymph", "mantle cell", "marginal zone",
                   "malt lymph", "hodgkin", "orbital lymph", "cns lymph",
                   "pediatric all", "primary cns", "abvd", "bv+avd", "bv avd",
                   "graall", "asparaginase")):
        tags.add("#lymphoma-other")

    if (has_word(blob, "aml", "apl", "mds")
            or has(blob, "acute myeloid", "acute promyelocytic", "myelodysplastic",
                   "atra+ato", "atra +ato", "ipss-r", "ipss r")):
        tags.add("#aml-apl")

    if has(blob, "multiple myeloma", "myeloma", "amyloidos", "drd schedule",
           "al amyloid", "plasma cell"):
        tags.add("#mm-amyloidosis")

    if (has_word(blob, "cll", "cml")
            or has(blob, "polycythemia", "myelofibros", "myeloproliferative",
                   "jak2", "essential thrombocyt", "richter")):
        tags.add("#cll-mpn")

    if has(blob, "iron deficiency", "ida", "prca", "pure red cell",
           "hemolytic anem", "cold agglut", "lpl", "factor x", "factor viii",
           "ddavp", "von willebrand", "vwd", "itp", "immune thrombocyt",
           "thrombocytopen", "ttp", "thrombotic thrombocyt", "hit ",
           "heparin-induced", "sickle cell", "vaso-occlusive", "hemophilia",
           "blood product", "transfusion", "myelocyte", "eltrombopag",
           "epo or", "chemo anemia", "trasamin", "tranexamic", "txa ",
           "contact pathway", "immunethrombocytopen", "immune thrombocytopen",
           "鐵相關"):
        tags.add("#anemia-platelets-coag")

    if has(blob, "pdgfrb", "myofibroma"):
        tags.add("#pdgfrb-myofibroma")

    if has(blob, "breast cancer", "tnbc", "her2-positive breast", "her2+ breast",
           "her2 positive breast", "hr+", "hr +", "hr positive", "mbc",
           "metastatic breast", "neoadjuvant breast", "adjuvant breast",
           "olympia", "olympiad", "monaleesa", "rxponder", "oncotype",
           "keynote-522", "keynote 522", "t-dxd", "t dxd", "trastuzumab",
           "sacituzumab", "ribociclib", "neratinib", "denosumab",
           "zoledronic", "stopeck", "e2108", "mf07-01", "mf07 01",
           "inavo123", "inavo 123", "inavolisib", "olaparib", "talazoparib",
           "rucaparib", "cdk4/6", "cdk46", "letrozole", "tamoxifen",
           "anastrozole", "kadcyla", "enhertu", "destiny-breast",
           "destiny breast", "bilateral breast", "synchronous bilateral",
           "mastectomy", "pertuzumab", "herceptin", "anti-her2", "anti her2"):
        tags.add("#breast-cancer")
    if has(blob, "brca", "hrd", "homologous recomb") and has(blob, "breast"):
        tags.add("#breast-cancer")

    if has(blob, "colorectal", "coad", "colon cancer", "colon adeno", "rectal cancer",
           "folfox", "folfiri", "folfoxiri", "regorafenib", "regorafnib",
           "regorafinib", "trifluridine", "longsurf", "lonsurf", "breakwater",
           "binimetinib", "prospect trial", "mucinus type colon", "mucinous colon",
           "mucinus colon", "irinotecan", "irinteacn", "keynote-177", "keynote 177"):
        tags.add("#colorectal-cancer")

    if has(blob, "pancreatic", "pancreas", "panc cancer", "胰臟", "esophageal",
           "esophagus", "esoph scc", "gastric cancer", "small bowel adeno",
           "small bowel cancer", "neuroendocrine", "nets ", "carcinoid",
           "hepatocellular", "hcc ", "cholangio", "biliary", "matterhorn",
           "cross trial", "calgb 9781", "keynote-585", "keynote 585",
           "checkmate 648"):
        tags.add("#gi-cancer-other")

    if has(blob, "non-small cell", "non small cell", "nsclc", "sclc",
           "small cell lung", "lung cancer", "lung adeno", "egfr exon",
           "keynote-671", "keynote 671", "atezolizumab", "cyfra",
           "肺癌", "肺腺癌"):
        tags.add("#lung-cancer")

    if has(blob, "rcc", "renal cell", "clear cell carcinoma", "mrcc",
           "kidney cancer", "prostate", "crpc", "abiraterone", "enzalutamide",
           "cabazitaxel", "cabaxitaxol", "bladder cancer", "urothelial",
           "nectin-4", "nectin 4", "chaarted", "cosmic 313", "cosmic-313",
           "stage 2 bladder"):
        tags.add("#gu-cancer")

    if has(blob, "ucec", "endometrial", "cervical cancer", "cervix",
           "ovarian cancer", "ovarian ca", "ovary cancer", "ovaries",
           "porte", "ruby", "garnet", "nrg_gy018", "interlace",
           "keynote-a18", "keynote a18", "beatcc", "kelim", "calla",
           "dostarlimab", "子宮頸癌", "高級漿液", "high grade serous",
           "pmmr", "pole positive"):
        tags.add("#gyn-cancer")
    if has(blob, "ovarian") and has(blob, "brca"):
        tags.add("#gyn-cancer")
    if has(blob, "bevacizumab", "avastin") and has(blob, "ovari"):
        tags.add("#gyn-cancer")

    if has(blob, "hnscc", "head and neck", "head & neck", "nasopharyngeal",
           "npc", "oropharyn", "p16", "hpv-positive", "hpv positive", "hpv+",
           "salivary gland", "epithelial myoepithelial", "afatinib",
           "toripalimab", "eortc 22931", "rtog 9501", "keynote-048",
           "頭頸", "鼻咽癌", "jupiter-02", "jupiter 02"):
        tags.add("#h-n-cancer")

    if has(blob, "sarcoma", "gist", "thyroid cancer", "lenvatinib", "lenva",
           "salivary myoepith", "salivary gland tumor", "spindle cell",
           "round cell tumor"):
        tags.add("#sarcoma-thyroid-rare-solid")

    if has(blob, "pik3ca h1047r", "pik3ca", "kras g12d", "nras q61l",
           "egfr exon 19", "egfr exon19", "erbb2", "her2 amplif",
           "brca1 deletion", "brca1 loss", "brca2 loss",
           "actionable somatic variant", "per-variant clinical", "tmb",
           "dmmr", "msi-h", "msi high"):
        tags.add("#variant-clinical-summary")
    if has(blob, "evidence-based clinical summary of") and has(blob, "mutation"):
        tags.add("#variant-clinical-summary")

    if has(blob, "abim hematology", "2026 abim", "board exam", "board review", "abim "):
        tags.add("#board-review-2026")

    if (has(blob, "下列", "何者", "true or false", "incorrect?", "correct?",
            "options¶", "選項：", "選項¶")
            or re.search(r"\bwhich of the following\b", blob)):
        tags.add("#board-mcq")

    if has(blob, "car-t", "car t cell", "bispecific", "blinatumomab", "crs",
           "icans", "astct", "cilta-cel", "ide-cel", "lisocabtagene",
           "cell therapy in the modern era", "fda-approved car"):
        tags.add("#cell-therapy")

    if has(blob, "mmrm", "propensity score", "kaplan-meier", "kaplan meier",
           "cox proportional", "log-rank", "cmh weighted",
           "cochran-mantel-haenszel", "missing data", "sensitivity analysis",
           "time-to-event", "trial design"):
        tags.add("#methodology-stats")

    if has(blob, "namd", "n amd", "anti-vegf", "anti vegf", "faricimab",
           "ranibizumab", "ang2", "angiopoietin", "intravitreal",
           "irf vs srf", "intraretinal fluid", "subretinal fluid"):
        tags.add("#ophthalmology")

    if has(blob, "tumor lysis", "tls ", "spinal cord compression", "mscc",
           "svc syndrome", "high-altitude", "in-flight", "acls",
           "epinephrine in emergen", "atropine, amiodarone", "naloxone",
           "d50w", "emergency drug protocol", "急救", "高空"):
        tags.add("#onc-emergency")

    if has(blob, "cancer pain", "cinp", "cipn", "duloxetine",
           "opioid constipation", "antiemetic", "cancer cachexia",
           "lymphedema", "epa) and", "eicosapentanoic", "docosahexaenoic",
           "fatigue", "exercise after", "structured exercise", "udca",
           "hyperbiliruben", "bone metastas", "skeletal-related event",
           "palliative", "trachea pall", "tumor progress in trachea",
           "calcium 1000", "calcium 1200", "older adults", "bone health",
           "omega 3", "omega-3", "fish oil"):
        tags.add("#supportive-care")

    if has(blob, "glp-1", "glp 1", "atrial fibrillation", "warfarin", "afib",
           "h pylori", "h. pylori", "h pyloric", "lendomin", "lendormin",
           "insomnia", "fibrate", "fenofibrate", "hpa axis", "hypothermia",
           "pyuria", "hypok", "hypo k", "hyperkal", "lactate for sepsis",
           "syphilis", "hpa-axis", "vitamin d", "維他命d", "gerd",
           "blood pressure", "anti+htn", "anti htn", "anti-htn",
           "blood pressure 150", "bp 150", "hypercalciuria", "weight training",
           "重訓", "dumbell", "exercise", "electrolyte powder", "electrolytes"):
        tags.add("#non-onc-medicine")

    if has(blob, "do and don", "do n don", "dose", "dosing", "discharge",
           "fmla", "avs ", "intake", "drug interaction", "drug-drug interaction",
           "po vs iv", "nccn recommendation", "nccn flow", "follow-up",
           "follow up", "chemo regimen", "treatment algorithm", "algorithm for",
           "regimen for", "first line treatment", "first-line treatment",
           "best practice", "how to treat", "treat protocol",
           "npo", "daily fluid", "post-transplant fever", "neutropenic fever",
           "alp", "口服", "靜脈注射", "rfa", "asthma", "what is aspirin",
           "aspirin medication", "antibiotic", "抗生素", "bresast pain",
           "breast pain during", "menstral period", "menstrual period"):
        tags.add("#patient-management")

    return tags


# ----------------------------- learning -----------------------------

def load_chats_and_memberships(conn: sqlite3.Connection) -> tuple[
    dict[str, list[str]], dict[str, set[str]], dict[str, str]
]:
    """Returns (chats: aid → tokens, tag_aids: tag_name → set[aid], tag_descs)."""
    chats: dict[str, list[str]] = {}
    for aid, title, question, parent in conn.execute(
        "SELECT article_id, title, question, parent_thread_json FROM chats"
    ):
        chats[aid] = tokenize(chat_text(title, question, parent))

    cid_to_name: dict[str, str] = {}
    cid_to_desc: dict[str, str] = {}
    for cid, name, desc in conn.execute(
        "SELECT collection_id, name, COALESCE(description,'') FROM collections "
        "WHERE is_hashtag=1"
    ):
        cid_to_name[cid] = name
        cid_to_desc[cid] = desc

    tag_aids: dict[str, set[str]] = collections.defaultdict(set)
    for cid, aid in conn.execute(
        "SELECT m.collection_id, m.article_id FROM memberships m "
        "JOIN collections col ON col.collection_id=m.collection_id "
        "WHERE col.is_hashtag=1"
    ):
        if cid in cid_to_name:
            tag_aids[cid_to_name[cid]].add(aid)
    return chats, dict(tag_aids), {cid_to_name[c]: d for c, d in cid_to_desc.items()}


def build_signatures(
    chats: dict[str, list[str]],
    tag_aids: dict[str, set[str]],
    held_out: dict[str, set[str]] | None = None,
) -> dict[str, dict[str, float]]:
    """Per-tag {term: z-score} via informative-Dirichlet log-odds-ratio."""
    held_out = held_out or {}
    corpus_freq: collections.Counter[str] = collections.Counter()
    for toks in chats.values():
        corpus_freq.update(toks)
    alpha_total = sum(corpus_freq.values())

    sigs: dict[str, dict[str, float]] = {}
    for tag, aids in tag_aids.items():
        masked = aids - held_out.get(tag, set())
        if not masked:
            continue
        tag_freq: collections.Counter[str] = collections.Counter()
        for aid in masked:
            if aid in chats:
                tag_freq.update(chats[aid])
        n_tag = sum(tag_freq.values())
        if n_tag < 5:
            continue
        scores: dict[str, float] = {}
        for w, fw in tag_freq.items():
            if fw < 2:
                continue
            alpha = corpus_freq[w]
            other_w = corpus_freq[w] - fw
            n_other = alpha_total - n_tag
            num1 = fw + alpha
            den1 = n_tag + alpha_total - num1
            num2 = other_w + alpha
            den2 = n_other + alpha_total - num2
            if den1 <= 0 or den2 <= 0 or num1 <= 0 or num2 <= 0:
                continue
            log_odds = math.log(num1 / den1) - math.log(num2 / den2)
            variance = 1.0 / num1 + 1.0 / num2
            z = log_odds / math.sqrt(variance) if variance > 0 else 0.0
            if z > 0:
                scores[w] = z
        sigs[tag] = scores
    return sigs


def score_tags(
    text: str,
    sigs: dict[str, dict[str, float]],
    *,
    top_n_terms: int = 20,
) -> dict[str, float]:
    chat_tokens = set(tokenize(text))
    if not chat_tokens:
        return {}
    out: dict[str, float] = {}
    for tag, term_scores in sigs.items():
        present = [term_scores[t] for t in chat_tokens if t in term_scores]
        if not present:
            continue
        present.sort(reverse=True)
        out[tag] = sum(present[:top_n_terms])
    return out


def predict(
    title: str,
    question: str,
    parent_thread_json: str | None,
    sigs: dict[str, dict[str, float]],
    *,
    threshold: float,
    top_k: int,
    top_n_terms: int,
    rules_only: bool = False,
    no_rules: bool = False,
) -> list[str]:
    body = (question or "") + " " + chat_text("", "", parent_thread_json)
    rule_tags = set() if no_rules else apply_rules(title or "", body)
    if rules_only:
        learned: set[str] = set()
    else:
        scores = score_tags(chat_text(title, question, parent_thread_json), sigs,
                            top_n_terms=top_n_terms)
        above = sorted(
            ((t, s) for t, s in scores.items() if s >= threshold),
            key=lambda x: -x[1],
        )[:top_k]
        learned = {t for t, _ in above}
    union = sorted(rule_tags | learned)
    return union or ["#misc"]


# ----------------------------- subcommands -----------------------------

def open_db(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(str(path))


def resolve_db(args: argparse.Namespace) -> Path:
    return args.db or Path(os.environ.get("OE_MCP_DB_PATH") or HOME_DEFAULT_DB)


def cmd_classify(args: argparse.Namespace) -> int:
    conn = open_db(resolve_db(args))
    chats_tokens, tag_aids, _ = load_chats_and_memberships(conn)
    sigs = build_signatures(chats_tokens, tag_aids)

    if args.reclassify_all:
        rows = conn.execute(
            "SELECT article_id, title, question, parent_thread_json FROM chats "
            "ORDER BY datetime_created DESC"
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT c.article_id, c.title, c.question, c.parent_thread_json
            FROM chats c
            WHERE c.article_id NOT IN (
              SELECT m.article_id FROM memberships m
              JOIN collections col ON col.collection_id=m.collection_id
              WHERE col.is_hashtag=1
            )
            ORDER BY c.datetime_created DESC
            """
        ).fetchall()

    plan = []
    counts: dict[str, int] = collections.Counter()
    for aid, title, question, parent in rows:
        tags = predict(
            title or "", question or "", parent, sigs,
            threshold=args.threshold,
            top_k=args.top_k,
            top_n_terms=args.top_n_terms,
            rules_only=args.rules_only,
            no_rules=args.no_rules,
        )
        plan.append({"article_id": aid, "hashtags": tags})
        for t in tags:
            counts[t] += 1
    Path(args.output).write_text(json.dumps(plan, ensure_ascii=False, indent=2))
    if not args.quiet:
        print(f"wrote {len(plan)} predictions to {args.output}")
        for tag in sorted(counts, key=lambda k: (-counts[k], k)):
            print(f"  {counts[tag]:4}  {tag}")
    conn.close()
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    """Hold-one-out per chat: hide all of one chat's tags, predict, score."""
    conn = open_db(resolve_db(args))
    chats_tokens, tag_aids, _ = load_chats_and_memberships(conn)

    aid_to_tags: dict[str, set[str]] = collections.defaultdict(set)
    for tag, aids in tag_aids.items():
        for aid in aids:
            aid_to_tags[aid].add(tag)

    rows = conn.execute(
        "SELECT article_id, title, question, parent_thread_json FROM chats"
    ).fetchall()
    aid_to_row = {r[0]: r for r in rows}

    per_tag_tp: collections.Counter[str] = collections.Counter()
    per_tag_fp: collections.Counter[str] = collections.Counter()
    per_tag_fn: collections.Counter[str] = collections.Counter()
    overall_correct = 0
    overall_total = 0

    for aid, true_tags in aid_to_tags.items():
        if aid not in aid_to_row:
            continue
        held = {t: {aid} for t in true_tags}
        sigs = build_signatures(chats_tokens, tag_aids, held_out=held)
        _, title, question, parent = aid_to_row[aid]
        pred = set(predict(
            title or "", question or "", parent, sigs,
            threshold=args.threshold, top_k=args.top_k, top_n_terms=args.top_n_terms,
            rules_only=args.rules_only, no_rules=args.no_rules,
        ))
        for t in pred & true_tags:
            per_tag_tp[t] += 1
        for t in pred - true_tags:
            per_tag_fp[t] += 1
        for t in true_tags - pred:
            per_tag_fn[t] += 1
        if pred & true_tags:
            overall_correct += 1
        overall_total += 1

    print(f"hit-rate (≥1 true tag predicted): {overall_correct}/{overall_total} "
          f"= {100*overall_correct/max(1,overall_total):.1f}%")
    print()
    print(f"{'tag':<32} {'TP':>4} {'FP':>4} {'FN':>4} {'P':>5} {'R':>5} {'F1':>5}")
    keys = sorted(set(per_tag_tp) | set(per_tag_fp) | set(per_tag_fn))
    for t in keys:
        tp = per_tag_tp[t]
        fp = per_tag_fp[t]
        fn = per_tag_fn[t]
        p = tp / (tp + fp) if (tp + fp) else 0.0
        r = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * p * r / (p + r) if (p + r) else 0.0
        print(f"{t:<32} {tp:>4} {fp:>4} {fn:>4} {p:>5.2f} {r:>5.2f} {f1:>5.2f}")
    conn.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", type=Path, default=None,
                    help=f"SQLite path (default $OE_MCP_DB_PATH or {HOME_DEFAULT_DB})")
    ap.add_argument("--threshold", type=float, default=8.0,
                    help="z-score threshold for learned tags (default 8.0)")
    ap.add_argument("--top-k", type=int, default=3,
                    help="max learned tags per chat (default 3)")
    ap.add_argument("--top-n-terms", type=int, default=20,
                    help="how many top distinctive terms to sum per tag (default 20)")
    ap.add_argument("--rules-only", action="store_true",
                    help="skip the learned signature, use keyword rules only")
    ap.add_argument("--no-rules", action="store_true",
                    help="skip the keyword rules, use learned signature only")

    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("classify",
                       help="Predict hashtags for unsorted chats; write plan JSON.")
    s.add_argument("--output", default="/tmp/proposed-plan.json")
    s.add_argument("--reclassify-all", action="store_true",
                   help="Predict for every chat (audit), not just unsorted ones.")
    s.add_argument("--quiet", action="store_true")
    s.set_defaults(func=cmd_classify)

    s = sub.add_parser("validate",
                       help="Held-out CV against current memberships. "
                            "Reports per-tag P/R/F1.")
    s.set_defaults(func=cmd_validate)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
