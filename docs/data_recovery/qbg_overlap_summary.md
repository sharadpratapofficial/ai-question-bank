# QBG workbook overlap: AutoCuration vs Important IDs Replica

Machine-readable: `data/reports/qbg_overlap_report.csv` (per sheet) and `data/reports/recovery_summary.json` (`overlap`).

| Measure | Value |
|---|---|
| Unique QBG ids in AutoCuration (row id or link) | 16736 |
| Unique QBG ids in Important IDs (usage cells, mirrors excluded) | 23024 |
| Union | 38033 |
| Intersection | 1727 |
| AutoCuration only | 15009 |
| Important IDs only | 21297 |
| % of Important IDs also in AutoCuration | 7.5% |
| % of AutoCuration also in Important IDs | 10.32% |
| AutoCuration rows with no QBG id | 17385 |
| AutoCuration extra rows repeating an id | 47 |
| Ids used in more than one test instance | 1681 |
| Ids used in more than one test family | 74 |

## By Important IDs sheet

| Sheet | Family | Unique ids | Also in AutoCuration | Only in Important IDs | % |
|---|---|---|---|---|---|
| JRTS | JRTS | 561 | 5 | 556 | 0.89 |
| RTS | RTS | 1691 | 7 | 1684 | 0.41 |
| AITS | AITS | 7686 | 1607 | 6079 | 20.91 |
| PYQs | PYQ | 10189 | 99 | 10090 | 0.97 |
| Onepass Test Series | ONEPASS | 2414 | 9 | 2405 | 0.37 |
| Full length JEE Main+Advanced ( | FULL_LENGTH | 558 | 8 | 550 | 1.43 |

## Intersection by AutoCuration `source`

| AutoCuration source | Ids also in Important IDs |
|---|---|
| 3QuestionBank | 16 |
| AIR | 129 |
| AITS | 1603 |
| Milestone | 12 |

## AutoCuration-only by `source`

| AutoCuration source | Ids only in AutoCuration |
|---|---|
| 3QuestionBank | 391 |
| AIR | 4959 |
| Milestone | 9086 |
| NEET-PYQ-2021 | 45 |
| NEET-PYQ-2022 | 45 |
| NEET-PYQ-2023 | 45 |
| NEET-PYQ-2024 | 45 |
| NEET-PYQ-2025 | 45 |
| NEET-PYQ-2026 | 45 |
| Prayas_Advance_New | 317 |

## What the overlap means

- **The two workbooks index mostly different questions.** Only 1,727 ids (7.5% of the test-mapping ids) have AutoCuration metadata. The two files are complementary views, not two copies of one bank.
- **Nearly all of the intersection is AITS.** 1603 of 1,727 shared ids come from AutoCuration rows whose source is `AITS`. For these, AutoCuration re-states the AITS sheet's taxonomy, so it cross-checks the same test data rather than independently confirming it.
- **AutoCuration-only ids** (Milestone, AIR, 3QuestionBank, Prayas_Advance_New, NEET PYQs) are curation-pool questions with no recorded test usage in the replica.
- **Important-IDs-only ids** (PYQs, RTS, JRTS, Onepass, Full length, most AITS 2023-24) have test usage but no row-level taxonomy apart from the AITS sheet's own columns.
- **Many ids are reused across tests.** 1,681 ids appear in more than one test instance, and 74 in more than one test family. Each id is one canonical question with several occurrences.
- **Neither workbook holds question bodies.** Content has to come from QBG (by unique_id, with authorised access) or from the Drive documents referenced per row.
