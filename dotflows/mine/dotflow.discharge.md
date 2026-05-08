---
id: "a5817a93-ac22-4677-bb87-ea0f11504deb"
name: ".discharge"
quick_description: "Produces a structured, templated inpatient discharge summary in plain text."
is_default: true
is_user_default: false
in_public_library: true
library_is_anonymous: false
has_unpublished_changes: false
access_level: "creator_only"
creator: null
creator_auth0_id: null
shared_with_emails: []
shared_emails: []
invocation_count: 1531
output_schemas: {}
created_at: "2026-02-19T08:39:12.341359Z"
updated_at: "2026-02-19T08:39:12.341379Z"
---

Format my inputs into a discharge summary using the following rules:
CRITICAL RULES
• Always refer to the patient as "the patient."
• Refer to the medical team in first person plural when appropriate.
• Follow the template exactly — no added or omitted sections.
• Do not assume or invent information.
• Plain text only. No markdown.
OUTPUT TEMPLATE
Use these exact section headers in this order:
DISCHARGE SUMMARY
Patient Name / MRN / DOB / Sex / Admission Date / Discharge Date / Length of Stay / Attending / Admitting Service / Discharge Disposition / Code Status
CHIEF COMPLAINT
PRINCIPAL DIAGNOSIS
SECONDARY DIAGNOSES
PROCEDURES PERFORMED
BRIEF HOSPITAL COURSE
One-Liner
Hospital Course by Problem
CONSULTATIONS
SIGNIFICANT DIAGNOSTIC STUDIES
Labs on Admission
Labs on Discharge
Microbiology/Cultures
Imaging
Other Studies
HOSPITAL COMPLICATIONS
ANTIBIOTICS ADMINISTERED
DISCHARGE MEDICATIONS
MEDICATIONS DISCONTINUED/CHANGED
DISCHARGE CONDITION
Activity Level / Diet / Functional Status / Cognitive Status / Hemodynamic Stability
PENDING STUDIES AT DISCHARGE
FOLLOW-UP APPOINTMENTS
DISCHARGE INSTRUCTIONS AND PATIENT EDUCATION
CARE TRANSITIONS AND OUTSTANDING ISSUES
DISCHARGE SUMMARY STATEMENT
Dictated/Prepared by / Date / Signature
Given these instructions, generate the discharge summary.
