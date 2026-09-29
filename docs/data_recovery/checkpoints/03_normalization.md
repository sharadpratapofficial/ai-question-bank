# Checkpoint 03: normalisation

**Status:** complete. `scripts/data/recovery/lib/normalize.mjs`, `lib/ids.mjs`; tests `scripts/data/recovery/tests/normalize.test.mjs` (11/11 pass: `node --test "scripts/data/recovery/tests/*.test.mjs"`).

Every normaliser returns `{raw_value, normalized_value, normalization_rule, confidence, status}` with status `OK | EMPTY | UNRESOLVED`.
When a value is UNRESOLVED, normalized_value is null and the raw value is kept.

| Normaliser | Canonical output | Notable rules |
|---|---|---|
| question type | app `QuestionType` strings + `Comprehension(COMP)` | `Numerial`→Numerical (typo), `Int`→Integer, `Para*`→COMP/Passage_Numerical (medium), `List Type`→UNRESOLVED |
| difficulty | Easy/Medium/Hard | codes 1/2/3 (QBG scale per `DIFFICULTY_MAP`); `Difficult`→Hard (medium); `0`→EMPTY |
| subject | Physics/Chemistry/Maths/… | `Mathematics`/typos→`Maths` (QBG taxonomy name); `PCM`→UNRESOLVED |
| class level | "9".."12" | file names/URLs in class column → UNRESOLVED `NOT_A_CLASS_DOCUMENT_REF` |
| exam | `{exam, paper}` JEE Main / JEE Advanced / NEET | `2022_P1` → year+paper only, exam null (medium) |
| taxonomy name | cleaned name | whitespace, wrapping `[ ]`; `-` → EMPTY; a 25-char id in a name column → UNRESOLVED |
| QBG id / parent id | verbatim | trim only; never lower-cased; parent accepts QBG cuid or UUID |
| link | `{kind,id,url}` | QBG page / Drive file / Drive folder / Google Sheet/Doc; nothing fetched |
| answer | app `answer_key` | option types → 1-based index array; Integer → number; decimals stay strings (`"64.00"`); COMP/unknown type → UNRESOLVED (a lone `3` is ambiguous) |
| options | `[{text,isCorrect}]` | `A~B~C~D` → `OPTION_LABELS_ONLY`, never content |
| rich text | whitespace-only cleanup | HTML/MathML/`<img>` preserved |
| dedupe key | comparison-only string | tags stripped, entities decoded, NFKC, lowercase |

## Next

Stage the sources into row-level JSONL, then build the QBG ID master (checkpoint 04).
