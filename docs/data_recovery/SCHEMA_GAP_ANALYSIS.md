# Schema gap analysis: canonical model vs reconstructed Supabase schema

Compares [CANONICAL_DATA_MODEL.md](CANONICAL_DATA_MODEL.md) with `scripts/sql/000_rebuild_schema.sql` (baseline documented in `docs/SCHEMA_REBUILD_AUDIT.md`).
**No schema change has been made.** The SQL at the end is a proposal only and has not been run anywhere.

Confidence labels: **VERIFIED** (from a migration or unambiguous app code) · **INFERRED** (a compatibility choice) · **UNKNOWN**.

## 1. `qbg_questions`, field by field

| Field | Current schema | Recovered data | Action | Confidence |
|---|---|---|---|---|
| question_id | uuid PK | uuidv5(record_key), deterministic | Keep. The import upserts on it, so re-runs are idempotent | VERIFIED type; values minted (not historical) |
| qbg_id | text, nullable, not unique | 38,033 QBG unique_ids (25-char base-36); null for 17,460 non-QBG records | Keep `text`. Add a partial unique index **only after** import proves uniqueness (the canonical set is unique; validator check passes) | INFERRED (historical type UNKNOWN) |
| question_text | text | 75 from docx (40 without placeholders, 35 with unconverted equations/symbols); 0 for QBG ids | No change. Metadata-only rows are **not** loaded into this operational table | VERIFIED |
| options | jsonb `[{text,isCorrect}]` | 59 complete docx option sets (Q59 incomplete → null); workbook "Option Text" is labels only | No change | VERIFIED |
| answer_key | jsonb | index arrays / numbers / decimal strings: 678 QBG ids + 75 docx | No change. JSONB carries every shape | VERIFIED |
| solution_text | text | 75 docx (26 without placeholders) | No change | VERIFIED |
| question_type | text | app `QuestionType` strings plus `Comprehension(COMP)` / `Passage_Numerical` | No change (the app accepts any string) | VERIFIED |
| subject / chapter / topic / subtopic | text | canonical names; chapter/topic/subtopic **ids** also recovered | Add id columns (see §3) or keep ids in `raw_data`. Name-only filtering keeps working | INFERRED |
| source | text | AutoCuration `source` (16 values) | No change | VERIFIED |
| difficutly_level | text (misspelled real name) | Easy/Medium/Hard | Mapped from canonical `difficulty_level` at import | VERIFIED |
| class_level | text | "11"/"12" | No change | VERIFIED |
| exam | text[] | "JEE Main"/"JEE Advanced"/"NEET" union of all occurrences | No change. The vocabulary is INFERRED (the old DB used QBG `examDetails` names such as "JEE Mains") | INFERRED |
| parent_question_id | text | 3 LOW-confidence "Comp" candidates plus 140 consecutive-position repeats (a comprehension-parent pattern) | Leave null. Candidates are in `parent_question_candidates` and the review queue | INFERRED/UNKNOWN |
| raw_data | jsonb | provenance goes in `raw_data[0]._recovery`, keeping the array shape | No change | VERIFIED shape |
| status | question_status, default verification_pending | imports set `verification_pending` | No change | VERIFIED |
| source_docx | jsonb | not produced (no docx media bucket upload) | Null | VERIFIED |
| created_by / last_modified_* | uuid / timestamptz | not applicable to recovered rows | Null / default | VERIFIED |
| origin_type | **absent** | on every record | Keep in `raw_data[0]._recovery` now. Optional column later | INFERRED |
| recovery_class, per-aspect confidence, import_readiness | **absent** | on every record | Keep in `raw_data[0]._recovery` | INFERRED |
| conflict / duplicate references | **absent** | 1,480 conflicts, 188 groups | New tables (§3) | INFERRED |

## 2. `qbg_question_pool` vs recovered data

`qbg_question_pool` (VERIFIED, from `create_qbg_question_pool.sql`) is the table the original **QBG export** (`QBG_data.csv`, not in the repo) was loaded into. Its `content` / `solutions` / `bilingual_options` / `answer` JSONB columns are exactly the question bodies this recovery lacks.

| Pool column | Recovered | Gap |
|---|---|---|
| unique_id / qbg_id | yes (38,033) | none |
| question_type, difficulty_level, subject, chapter, topic, subtopic, class_level, source | yes (AutoCuration/AITS) | none |
| used_in_exam | AutoCuration `used_in_exam` batch names | app-owned column; do not overwrite |
| content, bilingual_options, solutions, bilingual_solutions, answer | **no** (answer only for 678) | needs the QBG export or authorised API |
| concept_tags, exam_details, sources, child_questions, languages | **no** | needs the QBG export |

The pool is the natural landing place for **metadata-only** QBG ids. Populating it, though, requires a decision: the importer upserts by `unique_id` and the app filters on it, and a pool full of body-less rows would surface empty questions in the pipeline UI. **Recommendation:** load bodies into the pool only when the export or API access is available, and keep metadata in the proposed side tables until then.

## 3. Proposed additions (NOT applied)

| Proposed table | Needed? | Rows ready now | Why |
|---|---|---|---|
| `qbg_question_test_occurrences` | **Yes** | 25,096 | answers "which tests used this question / which questions were in JRTS" without duplicating questions |
| `qbg_source_documents` | **Yes** | 8,836 | document → question-occurrence model; drives future content recovery |
| `qbg_question_metadata` | Yes (or merge into raw_data) | 55,418 | per-field candidates + sources behind every canonical value |
| `qbg_question_conflicts` | **Yes** | 1,480 | human review; nothing is auto-resolved |
| `qbg_question_duplicates` | Yes | 188 | review of passage-parent repeats and multi-row ids |
| `qbg_question_provenance_edges` | Optional | 169,119 | graph queries; derivable from the tables above |
| `pyq_register`, `concept_register`, `archetype_register`, `reference_book_register` | When RankUp files arrive | 0 | RankUp grounding metadata; never mixed into qbg_questions |
| `rankup_generated_questions`, `rankup_question_provenance`, `rankup_question_qc` | When RankUp files arrive | 0 | generated-question provenance + V1–V10 QC |

`qbg_questions` stays focused on the operational question record, as the brief requires.

```sql
-- PROPOSAL ONLY. Review before use. Idempotent. Not part of 000_rebuild_schema.sql.
create table if not exists public.qbg_source_documents (
  document_id text primary key,            -- gdrive:<id> | gdrive-folder:<id> | gsheet:<id> | local:<file>
  source_url text, source_type text, provider text,
  filenames text[] default '{}', question_or_solution text, role_basis text, role_confidence text,
  associated_qbg_ids_count int, associated_record_count int, contains_many_questions boolean,
  availability text, download_status text, extraction_status text, hash text, page_count int,
  license_provenance text, raw jsonb, imported_at timestamptz not null default now()
);
create table if not exists public.qbg_question_test_occurrences (
  occurrence_id text primary key,          -- impids:<sheet>!<cell>
  question_id uuid references public.qbg_questions(question_id) on delete set null, -- null until the question row exists
  qbg_id text, test_family text, test_name text, test_instance_key text, test_instance_determinate boolean,
  sheet text, source_row int, source_cell text, year text, date text, shift text, exam text, paper text,
  batch text, subject text, question_type text, question_number int, question_number_raw text,
  structure text, parse_confidence text, raw jsonb, imported_at timestamptz not null default now()
);
create index if not exists idx_qqto_qbg_id on public.qbg_question_test_occurrences (qbg_id);
create index if not exists idx_qqto_instance on public.qbg_question_test_occurrences (test_family, test_instance_key);
create table if not exists public.qbg_question_conflicts (
  conflict_id text primary key, record_keys text[] not null, qbg_ids text[] default '{}', field text,
  conflict_type text, severity text check (severity in ('HIGH','MEDIUM','LOW')), "values" jsonb not null,
  detail text, resolution text not null default 'UNRESOLVED', resolved_by uuid, resolved_at timestamptz
);
create table if not exists public.qbg_question_duplicates (
  duplicate_group_id text primary key, duplicate_type text, classification text, confidence text,
  members text[] not null, canonical_candidate text, similarity numeric, detail text, action text
);
-- qbg_question_metadata, qbg_question_provenance_edges, pyq_register, concept_register,
-- archetype_register, reference_book_register, rankup_generated_questions,
-- rankup_question_provenance, rankup_question_qc: same pattern, keyed as in
-- scripts/data/import/lib/specs.mjs; add when their data exists.
-- RLS: follow the 000_rebuild_schema.sql pattern (read for authenticated; write via service role only).
```

## 4. Unknowns that stay unknown

The following cannot be recovered from these sources:

- the historical type of `qbg_questions.qbg_id` and `parent_question_id`
- whether `qbg_id` was unique
- the original body-column nullability
- the original RLS
- the meaning of AITS unlabeled column M (integers 1–10)
- the exact meaning of AutoCuration `Row_Number`: INFERRED to be the question position, because it equals the AITS question number in the rows checked
