# Canonical data model (local)

This is the **local** canonical model produced by `scripts/data/recovery/`. It is not a database schema: every entity is a JSONL/JSON file under `data/canonical/`.
How it maps onto the reconstructed Supabase schema is covered in [SCHEMA_GAP_ANALYSIS.md](SCHEMA_GAP_ANALYSIS.md). Field-level definitions are in [DATA_DICTIONARY.md](DATA_DICTIONARY.md).

Design rules:

1. **One canonical question per identity.** Test usage is modelled as occurrences, and documents as containers of many questions (`document → question occurrences`, never `document = question`).
2. **Origins never mix.**
   - `ORIGINAL_QBG`: has a QBG unique_id.
   - `IMPORTED_EXTERNAL`: a curation row without a QBG id, or a question extracted from a document.
   - `PYQ_SOURCE`: PYQ register rows.
   - `RANKUP_GENERATED`: RankUp output.
   - `UNKNOWN`.

   A QBG question that is also a PYQ stays `ORIGINAL_QBG` and carries `pyq_listings`.
3. **No winner by order.** When sources disagree, the canonical field is `null`, the candidates are kept in `qbg_question_metadata`, and a row is written to `qbg_conflicts`.
4. **Raw values are always kept** next to normalised ones (staging rows, metadata candidates).
5. **Separate confidences** for identity, question content, options, answer, solution, taxonomy and provenance. There is never a single blended score.

```text
sources ──< source_documents ──< (document position) >── qbg_questions_canonical ──< qbg_question_test_occurrences >── test instance
                                                               │   │
                                  qbg_question_metadata ───────┘   ├──< question_conflicts
                                  taxonomy_nodes (by id) ──────────┤──< question_duplicates
                                                                   └──< provenance_edges
source_document_questions (IMPORTED_EXTERNAL, unlinked; PYQ-citation candidates → qbg ids)

pyq_register   concept_register   archetype_register   reference_book_register      (RankUp knowledge; UNAVAILABLE)
generated_questions ──< generated_question_sources (anchor/secondary PYQ) ──< generated_question_concepts (TC) ──< generated_question_archetypes (PA)
                    ──< question_qc_results (V1..V10, trap sweep C1..C8)
```

## Entities

| Entity (brief name) | File | Key | One row per | Status |
|---|---|---|---|---|
| sources | `sources.json` | source_id | raw source | populated (7) |
| source_documents | `source_documents.jsonl` | document_id (`gdrive:`, `gdrive-folder:`, `gsheet:`, `local:`, `filename:`) | referenced document | 8,836 |
| qbg_questions_canonical | `qbg_questions.jsonl` | question_id = uuidv5(record_key); record_key `qbg:<id>` / `acrow:<row>` | QBG id, or AutoCuration row without an id | 55,418 |
| (document questions) | `source_document_questions.jsonl` | question_id = uuidv5(`docx:<doc>#Q<n>`) | question extracted from a local document | 75 |
| qbg_id_master | `qbg_id_master.jsonl` | qbg_id | external QBG id, with every observation | 38,033 |
| qbg_question_metadata | `qbg_question_metadata.jsonl` | question_id | canonical record: per-field status, value, candidates and sources | 55,418 |
| qbg_question_test_occurrences | `qbg_test_occurrences.jsonl` | occurrence_id (`impids:<sheet>!<cell>`) | QBG-id cell in Important IDs | 33,882 (25,096 count as usage) |
| question_conflicts | `qbg_conflicts.jsonl` | conflict_id | disagreement | 1,480 |
| question_duplicates | `qbg_duplicates.jsonl` | duplicate_group_id | duplicate group | 188 |
| provenance graph | `provenance_edges.jsonl` | (from, relation, to) | edge | 169,119 |
| taxonomy | `taxonomy_nodes.jsonl` | taxonomy_id | QBG taxonomy node | 22,335 |
| identifier registry | `identifier_registry.json` | system | identifier system | 29 systems |
| pyq_register | `pyq_register.jsonl` | pyq_id | PYQ register row | 0 (UNAVAILABLE) |
| concept_register | `concept_register.jsonl` | concept_id (TC-…) | textbook concept | 0 (UNAVAILABLE) |
| archetype_register | `archetype_register.jsonl` | archetype_id (PA-…) | problem archetype | 0 (UNAVAILABLE) |
| reference_book_register | `reference_book_register.jsonl` | book_id | book card | 0 (UNAVAILABLE) |
| generated_questions | `rankup_questions.jsonl` | rankup_question_id | RankUp generated question | 0 (UNAVAILABLE) |
| generated_question_sources / _concepts / _archetypes | `rankup_provenance.jsonl` | (rankup_question_id, relation, target) | fusion edge | 0 |
| question_qc_results | `rankup_qc.jsonl` | (rankup_question_id, check) | QC check result | 0 |

## Canonical QBG question record (`qbg_questions.jsonl`)

```json
{
  "question_id": "uuid v5 of record_key (minted; not historical)",
  "record_key": "qbg:<unique_id> | acrow:<AutoCuration row>",
  "qbg_id": "25-char QBG unique_id or null",
  "origin_type": "ORIGINAL_QBG | IMPORTED_EXTERNAL",
  "question_text": null, "options": null, "options_status": "OPTION_LABELS_ONLY | NOT_APPLICABLE | MISSING",
  "answer_key": "[i] | [i,j] | 243 | \"2.43\" | null",
  "solution_text": null,
  "question_type": "…", "subject": "…", "chapter": "…", "topic": "…", "subtopic": "…",
  "source": "…", "difficulty_level": "Easy|Medium|Hard", "class_level": "11|12", "exam": ["JEE Main"],
  "parent_question_id": null, "parent_question_candidates": ["<Comp column id>"],
  "pyq_listings": [{"exam": "JEE Main", "date": "25 Feb 2021", "shift": "I", "question_number": 12}],
  "taxonomy_ids": {"chapter": "…", "topic": "…", "subtopic": "…"},
  "metadata_resolution": {"<field>": {"status": "SINGLE|AGREE|CONFLICT|NAME_VARIANTS_SAME_ID|FROM_TAXONOMY_ID", "value": "…", "n_candidates": 2}},
  "test_usage": {"occurrence_count": 2, "test_families": ["AITS"], "distinct_test_instances": 2},
  "documents": {"question_documents": ["gdrive:…"], "solution_documents": [], "qbg_question_page": "https://qbg-admin…"},
  "used_in_exam_batches": ["Kattar"],
  "conflict_ids": [], "conflict_status": "NONE|HAS_CONFLICTS|BLOCKING", "duplicate_group_ids": [],
  "recovery_class": "A_FULL … H_UNRESOLVED", "recovery_reasons": [],
  "confidence": {"identity": "HIGH", "question_content": "NONE", "options": "NONE", "answer": "MEDIUM", "solution": "NONE", "taxonomy": "HIGH", "provenance": "HIGH"},
  "import_readiness": "READY | READY_WITH_REVIEW | NOT_READY", "import_reasons": [],
  "provenance": {"identity_basis": "QBG_ID", "source_workbooks": [], "source_rows": [{"workbook": "…", "sheet": "…", "row": 2, "cell": "J2"}], "source_documents": [], "extraction_method": "…", "recovered_on": "2026-09-27"}
}
```

Document questions (`source_document_questions.jsonl`) have the same core fields, filled with real content. They add:

- `options_raw`, `answer_kind`, `pyq_reference_text`
- `pyq_reference` {parsed, candidate_qbg_ids, confidence LOW}
- `equations` (OLE object → WMF preview per equation)
- `images`, `extraction_status`, `extraction_issues`
- `qbg_link_status` / `qbg_link_evidence`

When imported, provenance lives in `raw_data[0]._recovery` (see `scripts/data/import/lib/specs.mjs`). `raw_data` stays an array because the app and `001_post_import_backfills.sql` read `raw_data->0`.

## RankUp generated-question record (`rankup_questions.jsonl`, when supplied)

```json
{
  "rankup_question_id": "…", "question_id": "uuid v5", "origin_type": "RANKUP_GENERATED",
  "question_text": "…", "options_raw": "…", "answer_raw": "…", "solution_text": "…",
  "subject": "Chemistry", "chapter": "…", "topic": "…", "subtopic": "…", "question_type": "…",
  "difficulty": "…", "ideal_time_seconds": null,
  "fusion": {"type": "SC", "anchor_pyq_ids": [], "secondary_pyq_ids": [], "concept_ids": [], "archetype_ids": [], "role_basis": "anchor column | ids found in row; roles not stated"},
  "trap": {"code": null, "recall_answers": [], "description": null},
  "qbg_file_id": "kept verbatim", "qbg_file_id_semantics": "UNKNOWN (kept separate; not treated as qbg_id)",
  "source_pdf_id": null, "source_solution_pdf_id": null, "source_file": "…", "source_row": 2
}
```

QC results are separate rows (`rankup_qc.jsonl`: check name + raw result). The modelled checks are V1 blind re-solve, V2 numerical recompute, V3 fusion audit, V4 trap audit, V5 uniqueness, V6 originality, V7 WAA, V8 ideal time, V9 language/formula/unit and V10 depth, plus the C1–C8 trap sweep from the chemistry engine. They are listed in `rankup_status.json`.

## Recovery classes

| Class | Criteria (exactly one per record, first match wins) |
|---|---|
| G_DUPLICATE | non-canonical member of a confirmed duplicate group |
| F_CONFLICT | ≥1 HIGH-severity conflict: answer, subject, qbg id vs link, option-vs-value type, or SCQ-vs-MCQ |
| A_FULL | identity HIGH/MEDIUM; question fully extracted (no placeholders); 4 options for option types; answer; complete solution; subject + type |
| B_CONTENT_WITHOUT_SOLUTION | as A, but the solution is missing or partial |
| H_UNRESOLVED | identity LOW and no taxonomy and no test usage |
| C_QUESTION_LINKED | question body located but incomplete, **or** no body but a source document + position is known |
| D_METADATA_PLUS_ANSWER | no body; metadata plus a workbook answer |
| E_METADATA_ONLY | no body, no answer; identity + taxonomy/test usage |
| H_UNRESOLVED | anything else with LOW identity |

Confidence levels follow the brief:
- HIGH: direct source with an exact id match.
- MEDIUM: strong relationship with one unresolved field.
- LOW: heuristic.
- UNKNOWN: no relationship.
- NONE: the value is absent, which is distinct from uncertain.

Only READY records (A/B, identity and content HIGH/MEDIUM, no open conflicts, `ORIGINAL_QBG`, chapter known) are eligible for automatic import.
