# Checkpoint 08: import scripts, tests, documentation, final audit

**Status:** complete.

- Import scripts `scripts/data/import/01…10`:
  - dry run by default
  - idempotent (upsert on uuidv5 / stable keys)
  - resumable (input-hash-bound state)
  - batched and logged
  - apply requires `--apply --confirm-project=<ref>` plus a service key, and an existing table
  - not run against any database
- `10_validate_import.mjs`: 9/9 plans PASS; 0 invalid rows, 0 duplicate keys.
- Tests: 30/30 pass. They cover normalisers (ids, answers, options, taxonomy, links, dates), classification, conflicts, duplicates, provenance/raw_data shape, docx parsing, RankUp parsing, serialization, dry run, idempotent import, resume, and the apply guards.
- Validation: 32/34 pass, 0 errors. The 2 warnings are data findings. The determinism check passes (a re-run gives byte-identical canonical files).
- `npx tsc --noEmit -p tsconfig.json --incremental false`: exit 0.
- `npm run build`: exit 0.
- `npm run lint`: exit 1 (pre-existing: `next lint` was removed in Next 16).
- `git diff --check`: exit 2, only for trailing whitespace in the pre-existing uncommitted change to `src/app/page.tsx` (not touched by this work).
- No commit, no push.
