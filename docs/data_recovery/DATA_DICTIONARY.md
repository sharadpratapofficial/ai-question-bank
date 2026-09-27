# Data dictionary

The authoritative field reference for the recovered data. Columns: field · source · meaning · type · nullable · example · normalisation · historically verified? · inferred? · confidence.
"Historically verified" means that the field existed with this meaning in the original system and is proven by a migration or the app code.
Abbreviations: **AC** = AutoCuration_Lovee (1).xlsx `data`; **II** = Important IDs REplica (1).xlsx; **TG** = qbg_tagging_table.csv.

## qbg_questions (canonical) - `data/canonical/qbg_questions.jsonl`

| Field | Source | Meaning | Type | Null | Example | Normalisation | Hist. verified | Inferred | Conf. |
|---|---|---|---|---|---|---|---|---|---|
| question_id | pipeline | row id for import | uuid | no | 25ddb5c9-bb65-5c22-91ac-4c0dec088a4e | uuidv5(record_key) | type yes; values no | values minted | HIGH |
| record_key | pipeline | identity key | text | no | qbg:qheknip5dh112gdhm6zewqm8j / acrow:12345 | — | no | yes | HIGH |
| qbg_id | AC.qbg_id, AC.link, II id cells | QBG unique_id | text(25) | yes | qheknip5dh112gdhm6zewqm8j | trim only | column exists; type UNKNOWN | text type | HIGH |
| origin_type | pipeline | ORIGINAL_QBG / IMPORTED_EXTERNAL | enum | no | ORIGINAL_QBG | — | no | yes | HIGH |
| question_text | docx only | question HTML | text | yes | null | whitespace only; markup kept | yes (column) | — | NONE for QBG ids |
| options | docx only | `[{text,isCorrect}]` | jsonb | yes | null | labels `A~B~C~D` never used | yes | — | NONE for QBG ids |
| options_status | AC.Option Text | what the option cell held | text | no | OPTION_LABELS_ONLY | — | no | yes | HIGH |
| answer_key | AC.Answer* | answer | jsonb | yes | [2,4] / 243 / "2.50" | see INFER-NORM-002 | yes (shape) | — | MEDIUM |
| solution_text | docx only | solution HTML | text | yes | null | — | yes | — | NONE for QBG ids |
| question_type | AC.question_type, AC.question_type_original, II Q.Type | type | text | yes | Single_Choice(SCQ) | alias table | yes | vocabulary | HIGH when agreed |
| subject | AC.subject, subject_code→TG, II Subject, AITS N/O | subject | text | yes | Physics | Maths for Mathematics | yes | vocabulary | HIGH/MEDIUM |
| chapter / topic / subtopic | AC names, AC codes→TG, AITS P–U | taxonomy names | text | yes | Motion in a Plane | from agreed id; swap-fixed | yes | display-name precedence | HIGH/MEDIUM |
| taxonomy_ids.{chapter,topic,subtopic} | AC codes, AITS | QBG taxonomy ids | text(25) | yes | 18w5r2dal5pkxruso8gp8putx | trim | no (not in qbg_questions) | — | HIGH |
| source | AC.source | curation source | text | yes | Milestone | whitespace | yes | — | HIGH |
| difficulty_level | AC difficulty (+code), AITS V/W | difficulty | text | yes | Medium | 1/2/3 → Easy/Medium/Hard | yes (as `difficutly_level`) | Difficult→Hard | HIGH/MEDIUM |
| class_level | AC.class, AC.class_name, Onepass Class | class | text | yes | 11 | 11th→11 | yes | 12th & Dropper→12 | MEDIUM |
| exam | AC.exam_type, II Pattern | exam families used | text[] | yes | ["JEE Main"] | Mains→JEE Main | yes (column) | vocabulary | MEDIUM |
| parent_question_id | — | comprehension parent | text | yes | null | never set by inference | column yes; values none | — | — |
| parent_question_candidates | AITS K "Comp" | possible parent ids | text[] | no | [] | — | no | yes | LOW |
| pyq_listings | II PYQs | JEE PYQ papers listing this id | json[] | no | [{exam, date, shift, question_number}] | — | no | — | HIGH |
| metadata_resolution | pipeline | per-field status/value | json | no | {subject:{status:"AGREE"}} | — | no | — | — |
| test_usage | II | usage summary | json | no | {occurrence_count:2} | mirrors excluded | no | — | HIGH |
| documents | AC links / hyperlinks | question/solution docs + QBG page | json | no | {question_documents:["gdrive:…"]} | — | no | role inferred | MEDIUM |
| used_in_exam_batches | AC.used_in_exam | batches it was curated into | text[] | no | ["Kattar"] | comma split | no | — | HIGH |
| conflict_ids / conflict_status | pipeline | links to conflicts | text[] / enum | no | BLOCKING | — | no | — | — |
| duplicate_group_ids | pipeline | links to duplicate groups | text[] | no | [] | — | no | — | — |
| recovery_class / recovery_reasons | pipeline | A–H class | enum / text[] | no | E_METADATA_ONLY | see model | no | criteria | — |
| confidence.{identity, question_content, options, answer, solution, taxonomy, provenance} | pipeline | per-aspect confidence | enum | no | HIGH | HIGH/MEDIUM/LOW/UNKNOWN/NONE | no | — | — |
| import_readiness / import_reasons | pipeline | READY / READY_WITH_REVIEW / NOT_READY | enum | no | NOT_READY | — | no | — | — |
| provenance.{identity_basis, source_rows, source_documents, extraction_method, recovered_on} | pipeline | lineage | json | no | {source_rows:[{workbook,sheet,row,cell}]} | — | no | — | HIGH |

## source_document_questions (docx) - extra fields

| Field | Meaning | Example | Conf. |
|---|---|---|---|
| source_question_number | number printed in the paper | 21 | HIGH |
| section | SECTION heading | PHYSICS | HIGH |
| options_raw | option HTML fragments exactly as parsed | ["1 : 1", …] | — |
| answer_kind | SCQ / INTEGER / NUMERICAL_STRING | SCQ | — |
| answer_sources_agree | ANSWER KEY vs the solution's "N. (k)" line | true | HIGH |
| pyq_reference_text / pyq_reference | citation text; parsed date/shift and candidate QBG ids | "25 Feb, 2021 (Shift-I)" / 30 candidates | LOW |
| equations.{question_ole, solution_ole}[] | `{ole_object, prog_id, preview_image}` per unconverted equation | word/embeddings/oleObject15.bin | HIGH |
| extraction_status / extraction_issues | EXTRACTED / NEEDS_REVIEW + reasons | QUESTION_HAS_1_UNCONVERTED_OLE_EQUATIONS | — |
| qbg_link_status / qbg_link_evidence | why no QBG id is attached | NO_QBG_MATCH | HIGH |

## qbg_test_occurrences - `data/canonical/qbg_test_occurrences.jsonl`

| Field | Source | Meaning | Example | Inferred | Conf. |
|---|---|---|---|---|---|
| occurrence_id | pipeline | `impids:<sheet>!<cell>` | impids:JRTS!H3 | — | HIGH |
| qbg_id / qbg_id_raw / qbg_id_status | II id cell | id as normalised / raw / OK·UNRESOLVED | "QUE ERROR" → UNRESOLVED | — | HIGH |
| question_id | join | canonical record | uuid | — | HIGH |
| test_family | sheet | AITS / JRTS / RTS / PYQ / ONEPASS / FULL_LENGTH | AITS | — | HIGH |
| test_name, series, year, date, shift, exam, paper, batch | sheet columns / block titles | test context | 2024-12-15, Arjuna | date parse | HIGH |
| test_instance_key / test_instance_determinate | pipeline | one test | AITS\|2024-12-15\|Arjuna\|JEE Main\| | segmented for JRTS/RTS/Onepass | HIGH / MEDIUM |
| subject, question_type, question_number (+ _raw) | sheet | position labels | Q038 → 38 | — | HIGH (labels have known errors) |
| language | — | not stated in sheets | null | — | — |
| structure / parse_confidence | pipeline | TABULAR, SIDE_BY_SIDE_BLOCK, MIRROR_OF_AITS, INVALID_ID_CELL | — | — | — |
| counts_as_usage | pipeline | false for mirrors / invalid ids | true | — | — |
| id_hyperlink_matches | II hyperlink | PYQ cell hyperlink id = cell id | true | — | HIGH |

## source_documents - `data/canonical/source_documents.jsonl`

| Field | Meaning | Example |
|---|---|---|
| document_id | `gdrive:<fileId>`, `gdrive-folder:`, `gsheet:`, `local:<file>`, `filename:<name>` | gdrive:1v-helXIMFHL2liFhbd70ggR9j3WoU8sL |
| source_url / source_type / provider | normalised link | https://drive.google.com/file/d/… |
| filenames | file-name cells hyperlinked to this document | Test-37_Physics_Arjuna JEE AIR Advanced Test (2025)_Q.pdf |
| question_or_solution / role_basis / role_confidence | QUESTION_PAPER, SOLUTION, VIDEO_SOLUTION, QUESTION_DOCUMENT_INFERRED, FOLDER, … | QUESTION_PAPER / file name suffix / HIGH |
| associated_qbg_ids(_count), associated_record_count, contains_many_questions | document → questions | 17 |
| availability / download_status / extraction_status | UNAVAILABLE_LOCALLY / NOT_ATTEMPTED / NOT_EXTRACTED (except local docx) | — |
| hash / page_count / license_provenance | only for local files | sha256 |

## qbg_conflicts / qbg_duplicates

| Field | Meaning |
|---|---|
| conflict_id, record_keys, qbg_ids, field, conflict_type, severity (HIGH/MEDIUM/LOW), values [{value, sources[]}], detail, resolution (always UNRESOLVED) | one disagreement; no winner chosen |
| duplicate_group_id, duplicate_type (EXACT_ID_MULTIPLE_WORKBOOK_ROWS, SAME_ID_TWICE_IN_ONE_TEST, SAME_SOURCE_POSITION*, EXACT_TEXT, NEAR_TEXT_*), classification, confidence, members, canonical_candidate, similarity, detail, action | one duplicate group; nothing deleted |

## qbg_id_master - `data/canonical/qbg_id_master.jsonl`

`qbg_id`, `question_id`, `identity_basis`, `identity_confidence`, `source_files`, `observations[]` ({source, sheet, row, cell, field, raw, normalized, confidence, link/hyperlink match}), `ac_row_count`, `occurrence_count`, `in_autocuration`, `in_important_ids`, `question_metadata_present`, `question_text_present`, `options_present`, `answer_present`, `solution_present`, `question_file_link`, `solution_file_link`, `linked_to_content_locally`, `metadata_only`, `subjects/chapters/topics/subtopics/question_types/difficulty_levels/classes/sources` (candidate values), `exam_occurrences`, `test_instances`, `parent_ids`, `duplicate_group`, `conflict_status`, `recovery_class`, `confidence`.

## RankUp (when supplied)

| Entity | Fields |
|---|---|
| pyq_register | pyq_id, fields{PYQ-ID, Ref, Chapter/Subtopic, Summary, Answer, Hook, Trap Lever, Used…} (verbatim table columns), source_file, source_line, origin_type=PYQ_SOURCE, raw_row |
| concept_register | concept_id (TC-XXX-###), fields{…}, source_file, source_line, origin_type=GENERATION_METADATA |
| archetype_register | archetype_id (PA-XXX-###), fields{Archetype, Chain, Hidden bridge, Fuses with, Trap, Level…} |
| reference_book_register | book_id, title, fields, usage_rule ("concepts/techniques only; never copy problems or wording") |
| rankup_questions | see CANONICAL_DATA_MODEL.md; `qbg_file_id` kept separate with semantics UNKNOWN |
| rankup_provenance | rankup_question_id, relation (ANCHOR_PYQ, REFERENCES_PYQ, USES_CONCEPT, USES_ARCHETYPE), target |
| rankup_qc | rankup_question_id, check (column name, e.g. "V1 blind re-solve"), result_raw |

## Staging (intermediate, `data/staging/`)

Every staged field is a NormResult `{raw_value, normalized_value, normalization_rule, confidence, status}`. `status` is OK, EMPTY or UNRESOLVED. Each AutoCuration row also keeps `raw` (every non-empty cell by `<col letter>:<header>`) and `hyperlinks`.
