# Routine: collection-sort

Auto-sort the user's OpenEvidence chat history into hashtag-prefixed
collections. Run when the user invokes this routine; do not run on a
timer of your own accord.

## Hard rules

1. **Only write to collections whose name starts with `#`.** Anything
   without a leading hash is a human-curated collection — never call
   `oe_collections_add_article` against it.
2. **Every unsorted chat must end up in ≥1 hashtag collection.** If
   nothing else fits, fall back to `#misc`.
3. **Reuse existing hashtags before minting new ones.** Run
   `oe_collections_list` first; mint only when an existing tag genuinely
   does not cover the chat. Justify any new tag in your text response.
4. **Multi-membership is fine.** A chat that's both a DLBCL question and
   a board-review summary belongs in both `#dlbcl` and
   `#board-review-2026`.
5. **Never modify human collections.** Do not rename, do not delete, do
   not add articles.

## Starter taxonomy

These hashtags are seeded from the user's existing question history.
Prefer them; expand only when you encounter a topic none of them covers.

**Heme (disease-specific)**
- `#dlbcl` — DLBCL frontline / R/R / CNS / Richter / transformation
- `#aml-apl` — AML, APL, FLT3, induction
- `#mm` — multiple myeloma
- `#cll` — CLL and its complications
- `#anemia-platelets-coag` — IDA, PRCA, ITP, eltrombopag, acquired hemophilia, TLS

**Solid tumor & molecular**
- `#variant-clinical-summary` — per-variant clinical evidence (PIK3CA, BRCA, KRAS G12D, NRAS Q61L, HER2, etc.)
- `#pdgfrb-myofibroma` — PDGFRB hotspot R561C/N666K tumors
- `#solid-tumor-clinical` — UCEC, COAD, BRCA, pancreatic clinical Q's not variant-specific

**Cross-cutting**
- `#board-review-2026` — ABIM Hematology 2026 study summaries
- `#cell-therapy` — CAR-T, bispecifics, FDA approvals
- `#methodology-stats` — trial design, MMRM, statistical Q's
- `#patient-management` — practical do/don't, dosing, FMLA, AVS, intake, discharge
- `#onc-emergency` — oncologic emergencies
- `#misc` — explicit fallback so the unsorted backlog always drains

## Procedure

### 1. Sync

Run from the repo root:

```bash
python scripts/collection_sort.py sync-history
python scripts/collection_sort.py sync-collections
```

First-ever run should add `--full` to `sync-history` to walk the whole
backlog. Subsequent runs are incremental — they stop at the first page
of history where every article is already known.

### 2. Survey

```bash
python scripts/collection_sort.py list-unsorted --json --limit 100
```

The output looks like:

```json
{
  "unsorted_count": 312,
  "shown": 100,
  "items": [
    {
      "article_id": "f5cbe041-…",
      "title": "Chemotherapy-Induced Heart Failure",
      "question_preview": "Cardiac-related mortality in a 64 y/o…",
      "datetime_created": "2026-05-08T06:22:24Z"
    }
  ]
}
```

Also call `oe_collections_list` so you have the live id ↔ name map for
hashtag collections (your local SQLite mirror may lag the API for
collections you create in this same session).

### 3. Plan assignments

For each item: read `title` + `question_preview`, then list the 1–N
hashtags that fit. Prefer the starter taxonomy. Fall back to `#misc`
only when nothing else applies. If you mint a new tag, justify it in
one sentence (and make sure no existing hashtag covers it).

### 4. Apply

For any tag you plan to use that does **not** already exist as a
collection: call once

```
oe_collections_create({ name: "#tag", description: "<one-line>" })
```

Capture the returned `id`. Then for each `(article_id, hashtag)` pair:

```
oe_collections_add_article({ collection_id: <id>, article_id })
```

Each call is independent. If one fails, keep going — the next routine
run picks up the residue.

### 5. Reconcile

```bash
python scripts/collection_sort.py sync-collections
python scripts/collection_sort.py summary
```

`unsorted_chats` should be `0`. If it's not, list what's left and
explain why (usually: an ambiguous chat the model deferred on — apply
`#misc` and finish).

## Output to the user

End the routine with a short summary:

- how many unsorted chats were processed
- which hashtag collections you created (if any) and why
- how many memberships you added
- residual `unsorted_chats` count after the final sync (target: 0)
