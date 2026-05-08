# My Public Dotflows

Public-library links for `mine/` dotflows on OpenEvidence. Pattern:
`https://www.openevidence.com/dotflows?libraryId={id}`.

Author: **Dr. 林協霆 (Hsieh-Ting, Lin)**.  Specialty stamping (`Internal Medicine`) is server-side auto-classified and not user-controllable; categories are likewise auto-assigned per OpenEvidence's renderer.

---

## Oncology & Hematology — NCCN-flavored backbone (v2)

Disease-agnostic structural prompts spanning the patient journey from bedside intake to critical appraisal of the literature.  v2 = critique-driven rewrite tightening hard limits, front-loading the actionable question, anchoring magnitude to risk-strat systems, and adding mimic rule-out / fitness / GOC / financial / vaccination axes that v1 missed.

| # | Name | What it does | Link |
| ---: | --- | --- | --- |
| 1 | `.onc_intake` | Generates a ≤250-word, structured oncology visit note that begins by clarifying the visit’s key question and then presents a concise patient one-liner, full line-by-line treatment history, prioritized problem list with evidence and… | [open](https://www.openevidence.com/dotflows?libraryId=298a4a2b-c20a-46f8-a6da-f3b0833a18ea) |
| 2 | `.onc_workup` | Generates an NCCN-guided, time-to-treatment–oriented diagnostic and staging workup for a suspected cancer primary—summarizing required labs, imaging, pathology/IHC/NGS, and a pre–cycle 1 day 1 readiness checklist with coordination steps… | [open](https://www.openevidence.com/dotflows?libraryId=66b5eab8-bb41-4753-93e4-bffd3571f1f2) |
| 3 | `.onc_regimen` | Generates an NCCN-aligned oncology regimen brief that prioritizes any actionable biomarker-directed therapy, then concisely provides a regimen table with premeds/prophylaxis, per-cycle visit checklist, CTCAE-based dose modifications,… | [open](https://www.openevidence.com/dotflows?libraryId=62027bf1-eb2a-4096-b6c8-07712cad2c73) |
| 4 | `.onc_emergency` | Generates a ≤250‑word, guideline-based oncologic emergency management plan that ranks likely emergencies by acuity and provides a triage table plus time-staged actions (first 30 minutes, within 4 hours) and disposition/consult… | [open](https://www.openevidence.com/dotflows?libraryId=8a1cd8b7-3562-4a88-98e1-f375605e0c35) |
| 5 | `.onc_irae` | Generates a ≤350‑word, guideline‑based immune checkpoint inhibitor irAE playbook that first rules out mimics and overlapping toxicities, then provides CTCAE v5 organ‑specific grading, stepwise management (ICI hold/discontinue, steroids… | [open](https://www.openevidence.com/dotflows?libraryId=d522a786-386b-46c0-bbe9-895c1ccb2dc9) |
| 6 | `.heme_workup` | This workflow rapidly screens for hematologic emergencies requiring immediate action, then synthesizes a WHO 5th/ICC 2022–based hematologic workup into a concise CBC/smear summary, a flow/cytogenetics/NGS implications table, a ranked… | [open](https://www.openevidence.com/dotflows?libraryId=62a86185-25cf-4105-bc8b-9769e8833619) |
| 7 | `.onc_mdt` | Generates a ≤250‑word tumor board clinician brief that starts with one prioritized actionable question, summarizes the patient’s oncologic history/fitness and any updates, presents a compact evidence‑graded options table (including… | [open](https://www.openevidence.com/dotflows?libraryId=8e1a29db-637b-4a9b-b62d-540566d85e9b) |
| 8 | `.onc_avs` | Creates a one-page, 6th-grade After Visit Summary for a patient starting new systemic cancer treatment, customized by drug class, that explains what the medicine does, the dosing schedule, expected side effects, when to call or go to… | [open](https://www.openevidence.com/dotflows?libraryId=06f3ed1b-5e01-4cee-9a9e-579fe515576a) |
| 9 | `.onc_survivorship` | Generates a concise, printable NCCN-style survivorship care plan for a post–curative-intent cancer patient that defines the oncology-to-PCP handoff timing and provides modality-specific late-effect risks with surveillance/mitigation, a… | [open](https://www.openevidence.com/dotflows?libraryId=7dcc45c4-1cf2-4f35-bf97-059cac564788) |
| 10 | `.onc_appraise` | Critically appraise a single oncology clinical trial for real-world clinical applicability by checking comparator fairness, summarizing PICO and endpoint magnitude (including ESMO-MCBS/ASCO value when possible), assessing bias,… | [open](https://www.openevidence.com/dotflows?libraryId=e03143b5-1f31-4265-b35e-36d7ab133bac) |

Sequence reads as: intake → staging → regimen → emergency → toxicity → heme dx → MDT → patient ed → survivorship → critical appraisal.  Designed to compose with `.succinct` and `.cross_trial`.

## Other personal flows

Earlier personal flows (some forked from OpenEvidence-curated originals).

| Name | What it does | Link |
| --- | --- | --- |
| `.cross_trial` | Synthesizes landmark clinical trials into a structured comparative table with key endpoints and generalizability notes. | [open](https://www.openevidence.com/dotflows?libraryId=e1bab9f3-f042-42ee-91c2-281c3191ac82) |
| `.discharge` | Produces a structured, templated inpatient discharge summary in plain text. | [open](https://www.openevidence.com/dotflows?libraryId=a5817a93-ac22-4677-bb87-ea0f11504deb) |
| `.fmla` | Converts a patient summary into compliance-focused FMLA or disability documentation emphasizing functional impairment. | [open](https://www.openevidence.com/dotflows?libraryId=14623f7e-0201-4b05-89e3-e8b6695ce642) |
| `.patient_context_pediatrics` | Adjusts clinical reasoning and management to reflect pediatric physiology, dosing, and age-specific considerations. | [open](https://www.openevidence.com/dotflows?libraryId=37d938f4-2080-45e5-90d7-f1495f5d4784) |
| `.prior_auth` | Generates a formal prior authorization or insurance appeal letter grounded in medical necessity. | [open](https://www.openevidence.com/dotflows?libraryId=02cd7510-7b4f-42dd-8952-52f1a5d81463) |
| `.succinct` | Delivers a concise, high-yield clinical response optimized for time-constrained physician use. | [open](https://www.openevidence.com/dotflows?libraryId=9c9a6e84-b828-41f4-ab3b-1b3799375b4b) |

## Private (not in public library)

Drafts kept private — `in_public_library: false`, no shareable link.

- `.avs_personal`
- `.nextsteps`

---

_Auto-generated from `dotflows/mine/` frontmatter._
