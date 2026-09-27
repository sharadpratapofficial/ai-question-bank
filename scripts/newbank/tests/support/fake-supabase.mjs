/**
 * Minimal file-backed stand-in for @supabase/supabase-js, covering only the calls in
 * scripts/newbank/lib/target.mjs. State lives in $NEWBANK_FAKE_DB (JSON) so the test
 * can inspect it after the CLI process exits. Counts reads and writes.
 */
import fs from "node:fs";

const file = process.env.NEWBANK_FAKE_DB;
const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { tables: {}, reads: 0, writes: 0 });
const save = (s) => fs.writeFileSync(file, JSON.stringify(s, null, 1));

class Query {
    constructor(table) { this.table = table; this.op = "select"; this.filters = []; }
    select() { return this; }
    in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
    eq(col, v) { this.filters.push((r) => r[col] === v); return this; }
    insert(rows) { this.op = "insert"; this.rows = rows; return this; }
    update(patch) { this.op = "update"; this.patch = patch; return this; }
    maybeSingle() { this.single = true; return this; }
    then(resolve, reject) { return Promise.resolve().then(() => this.exec()).then(resolve, reject); }
    exec() {
        const s = load();
        const rows = (s.tables[this.table] ??= []);
        const match = (r) => this.filters.every((f) => f(r));
        if (this.op === "insert") {
            // one statement is atomic, like Postgres: any PK clash rejects the whole batch
            if (this.rows.some((r) => rows.some((x) => x.question_id === r.question_id))) return { error: { message: "duplicate key value violates unique constraint" } };
            rows.push(...structuredClone(this.rows));
            s.writes++; save(s);
            return { error: null };
        }
        if (this.op === "update") {
            for (const r of rows) if (match(r)) Object.assign(r, structuredClone(this.patch));
            s.writes++; save(s);
            return { error: null };
        }
        s.reads++; save(s);
        const data = rows.filter(match).map((r) => structuredClone(r));
        return this.single ? { data: data[0] ?? null, error: null } : { data, error: null };
    }
}

export function createClient() {
    return { from: (table) => new Query(table) };
}
