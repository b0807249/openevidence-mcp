---
id: "06f3ed1b-5e01-4cee-9a9e-579fe515576a"
name: ".onc_avs"
quick_description: "Creates a one-page, 6th-grade After Visit Summary for a patient starting new systemic cancer treatment, customized by drug class, that explains what the medicine does, the dosing schedule, expected side effects, when to call or go to the ER, supportive care, financial help, follow-up, and a teach-back check."
is_default: false
is_user_default: false
in_public_library: true
library_is_anonymous: false
has_unpublished_changes: false
access_level: "creator_only"
creator: 3807007
creator_auth0_id: "google-oauth2|100561739740590230043"
shared_with_emails: []
shared_emails: []
invocation_count: 0
output_schemas: { "Side effects": "table", "When to call": "document", "Financial help": "document", "Supportive care": "document", "What this medicine does": "document" }
created_at: "2026-05-08T03:13:57.251962Z"
updated_at: "2026-05-08T03:47:04.610237Z"
---

Generate a patient-facing After Visit Summary for someone starting a new oncology systemic therapy.

LANGUAGE: 6th-grade reading level. Use 1-syllable words where possible. Short sentences. Active voice.

DRUG-CLASS FORK — tailor side-effect and call-rule emphasis to the class:
- Chemotherapy (cytotoxic): fever > 100.4 °F is the #1 rule, mouth sores, hair, neuropathy by drug, nadir window day 7–14.
- Immunotherapy (checkpoint inhibitor): "report ANY new symptom — diarrhea, cough, rash, headache, fatigue beyond usual"; do not start steroids on your own.
- Oral targeted (TKI / oral chemo): pill-taking schedule, food rules, drug-drug check (CYP3A4 inducers/inhibitors, PPI for some TKIs, grapefruit), specific tox (hand-foot, rash, BP for VEGF, hyperglycemia, QT for some).
- Hormonal (AI, tamoxifen, ADT, antiandrogen): hot flashes, bone health, mood, sexual function, BMD baseline, VTE risk for tamoxifen.

Format:

[DATE]
PATIENT NAME: [patient]
DIAGNOSIS: [plain-language diagnosis]
NEW MEDICINE STARTED TODAY: [drug names + class in plain words]

WHAT THIS MEDICINE DOES (2–3 sentences plain language):

YOUR SCHEDULE: infusion days, oral pill instructions, cycle length, next visit.

SIDE EFFECTS TO EXPECT (drug-class specific, table format).

CALL OUR OFFICE THE SAME DAY IF:
- Temperature ≥ 100.4 °F (38.0 °C) once, OR ≥ 100.0 °F (37.8 °C) for an hour
- Shaking chills
- Cannot keep fluids down > 12 hours
- New rash, mouth sores, or pain pills do not control
- New bleeding or bruising
- For immunotherapy ONLY: ANY new symptom anywhere — diarrhea, cough, rash, headache, weakness — even if minor.

GO TO ER IF: trouble breathing, chest pain, fainting, confusion, one-sided weakness, severe belly pain, vomiting blood, heavy bleeding that won't stop with pressure.

SUPPORTIVE CARE WE STARTED: anti-nausea meds, bowel plan, mouth / skin / hydration, birth control / fertility plan if relevant.

FINANCIAL HELP: drug-maker patient assistance program, copay foundation referral, social work contact, insurance prior auth status. Provide phone numbers when possible.

FOLLOW-UP: next labs, next clinic visit, infusion appointment.

TEACH-BACK: ask the patient to repeat back the fever rule and one side-effect-to-expect. Note in the chart whether teach-back succeeded.

QUESTIONS? Call [clinic phone] during business hours; after hours press [option].

Sincerely,
[Clinician name, credentials]

Hard limit: 1 printed page (≤ 350 words of body + format).
