# Checkpoint 05–07: ID master, cross-match, conflicts, duplicates, classification, identifiers, validation

**Status:** complete. Run everything with `node scripts/data/recovery/run_all.mjs` (~50 s). A second run produces byte-identical canonical outputs (verified by the determinism check).

## Headline counts

| Measure | Value |
|---|---|
| Canonical records | 55,418 = 38,033 unique QBG ids + 17,385 AutoCuration rows without a QBG id |
| Source-document questions (docx, unlinked) | 75 |
| QBG ids: AutoCuration / Important IDs / both | 16,736 / 23,024 / 1,727 (7.5 % of Important IDs) |
| QBG ids in test mappings | 23,024 (1,553 in more than one test instance) |
| QBG ids with an answer | 678 |
| QBG ids with a question / solution document link | 2,296 / 715 |
| Classes (all) | A 21 · B 19 · C 18,904 · D 678 · E 35,707 · F 144 · G 0 · H 20 |
| Classes (QBG ids) | C 1,504 · D 678 · E 35,707 · F 144 |
| Conflicts | 1,480 (HIGH 144, MEDIUM 515, LOW 821); all UNRESOLVED |
| Duplicate groups | 188 (47 same id on several AutoCuration rows, merged; 141 same id twice in one test, of which 140 are at consecutive positions, the comprehension-parent pattern) |
| Source documents | 8,836 (58 question papers, 66 solutions, 329 inferred question documents, 8,225 per-question video solutions, …), all UNAVAILABLE_LOCALLY except the 4 local docx |
| Import readiness | READY 0 · READY_WITH_REVIEW 40 (docx A/B, not QBG-linked) · NOT_READY 55,453 |
| Identifier collisions (question id vs taxonomy id) | 0 |
| Validation | 32/34 pass, 0 errors. The 2 WARN are data findings: 224 taxonomy paths missing from the tagging tables, and 44 invalid id cells |

## Decisions

- Rows without a QBG id are never merged: each becomes `acrow:<row>`. Rows at the same document position would be reported, not merged; none were found.
- Where sources disagree on a field, the canonical value is null and a conflict row is written. Taxonomy display names come from the id's name (tagging CSV preferred); name-only variants are LOW.
- For JRTS/RTS/Onepass, test instances are inferred from numbering resets because those sheets have no test number or date.
- Docx PYQ citations resolve to candidate QBG id sets (30 ids for 52 questions). They are LOW confidence and never auto-linked.

## Next

RankUp spec, import scripts (dry-run), tests, and documentation.
