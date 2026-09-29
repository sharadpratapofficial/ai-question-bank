#!/usr/bin/env node
/**
 * LOCAL validation of scripts/sql/000_rebuild_schema.sql,
 * 001_post_import_backfills.sql and 003_new_question_bank_support.sql (+ its
 * read-only verify script) on a disposable in-process PostgreSQL (PGlite).
 * All checks after the apply step run against 000 + 003, as on the live project.
 * Never connects to Supabase or any network database.
 *
 * PGlite is not a project dependency. Install it anywhere outside the repo and
 * point PGLITE_DIR at that folder:
 *
 *   mkdir %TEMP%\pgval && cd %TEMP%\pgval && npm init -y && npm i @electric-sql/pglite
 *   set PGLITE_DIR=%TEMP%\pgval        (PowerShell: $env:PGLITE_DIR="$env:TEMP\pgval")
 *   node scripts/sql/validate/validate_schema.mjs
 *
 * What it checks:
 *   - the migration applies on top of supabase_shim.sql, re-applies cleanly
 *     (idempotent), and also applies over a user_role enum from the old migration
 *   - static hazards: SETNULL typos, duplicate / redundant indexes, FK actions
 *   - the access model: anon can do NOTHING; the server's service_role does the
 *     bulk/background work; each app role gets exactly the access the app needs,
 *     via has_any_permission(), whose role map must equal src/lib/auth/permissions.ts
 *   - storage bucket policies, edit-history attribution, restore RPC, backfills
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.resolve(here, "..");
const repo = path.resolve(sqlDir, "..", "..");
const read = (p) => fs.readFileSync(p, "utf8");

const pgliteRoot = process.env.PGLITE_DIR ? path.join(process.env.PGLITE_DIR, "node_modules", "@electric-sql", "pglite", "dist") : null;
const load = (sub) => (pgliteRoot ? import(pathToFileURL(path.join(pgliteRoot, sub)).href) : import(sub === "index.js" ? "@electric-sql/pglite" : "@electric-sql/pglite/contrib/pgcrypto"));
const { PGlite } = await load("index.js");
const { pgcrypto } = await load(path.join("contrib", "pgcrypto.js"));
// The app's own role -> permission map (Node strips the TypeScript types).
const { ROLE_PERMISSIONS, ALL_ROLES } = await import(pathToFileURL(path.join(repo, "src", "lib", "auth", "permissions.ts")).href);

const SHIM = read(path.join(here, "supabase_shim.sql"));
const REBUILD = read(path.join(sqlDir, "000_rebuild_schema.sql"));
const BACKFILL = read(path.join(sqlDir, "001_post_import_backfills.sql"));
// Forward migration applied on top of 000 (new question bank: child_order + question-media).
const NEWBANK = read(path.join(sqlDir, "003_new_question_bank_support.sql"));
const NEWBANK_VERIFY = read(path.join(sqlDir, "003_verify_new_question_bank_support.sql"));

// ---------------------------------------------------------------- harness ---
const results = [];
async function check(name, fn) {
    try { results.push({ ok: true, name, note: await fn() }); } catch (e) { results.push({ ok: false, name, note: e?.message || String(e) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function expectError(db, sql, params, code) {
    try { await db.query(sql, params); } catch (e) {
        if (code && e.code !== code) throw new Error(`expected SQLSTATE ${code}, got ${e.code}: ${e.message}`);
        return `rejected (${e.code})`;
    }
    throw new Error(`expected an error${code ? ` ${code}` : ""}, statement succeeded`);
}
/** Run fn as a PostgREST-style role (anon / authenticated / service_role) with an optional JWT sub. */
async function as(db, role, sub, fn) {
    await db.exec(`set role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub || ""]);
    try { return await fn(); } finally {
        await db.exec("reset role");
        await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    }
}
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const all = async (db, sql, params) => (await db.query(sql, params)).rows;
const n = async (db, sql, params) => Number((await one(db, sql, params)).n);

// ------------------------------------------------------------- static ------
await check("static: no 'SETNULL' typo in any scripts/sql/*.sql", async () => {
    const hits = fs.readdirSync(sqlDir).filter((f) => f.endsWith(".sql")).filter((f) => /SETNULL/i.test(read(path.join(sqlDir, f))));
    assert(hits.length === 0, `found in: ${hits.join(", ")}`);
    return "0 occurrences";
});
await check("static: bootstrap never drops a table, column or schema, and never deletes/truncates data", async () => {
    const code = REBUILD.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    const bad = code.match(/\bdrop\s+(table|column|schema|type|extension)\b|\btruncate\b|\bdelete\s+from\b/gi) || [];
    assert(bad.length === 0, bad.join(", "));
});

// ------------------------------------------------------------ apply --------
const db = new PGlite({ extensions: { pgcrypto } });
const version = (await one(db, "select version() as v")).v;
await check("apply supabase_shim.sql", async () => { await db.exec(SHIM); });
await check("apply 000_rebuild_schema.sql (fresh)", async () => { await db.exec(REBUILD); });
const snapshot = async () => ({
    tables: await n(db, `select count(*) n from pg_tables where schemaname='public'`),
    policies: await n(db, `select count(*) n from pg_policies where schemaname in ('public','storage')`),
    indexes: await n(db, `select count(*) n from pg_indexes where schemaname='public'`),
    functions: await n(db, `select count(*) n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public'`),
    triggers: await n(db, `select count(*) n from pg_trigger where not tgisinternal`),
});
const first = await snapshot();
await check("apply 000_rebuild_schema.sql again (idempotent)", async () => { await db.exec(REBUILD); });
await check("second apply leaves object counts unchanged", async () => {
    const second = await snapshot();
    assert(JSON.stringify(first) === JSON.stringify(second), `${JSON.stringify(first)} vs ${JSON.stringify(second)}`);
    return JSON.stringify(second);
});
await check("static: 003 never drops a table, column, schema or type, and never deletes/truncates data", async () => {
    const code = NEWBANK.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    const bad = code.match(/\bdrop\s+(table|column|schema|type|extension|constraint)\b|\btruncate\b|\bdelete\s+from\b/gi) || [];
    assert(bad.length === 0, bad.join(", "));
});
await check("apply 003_new_question_bank_support.sql over 000", async () => { await db.exec(NEWBANK); });
const after003 = await snapshot();
await check("apply 003 again (idempotent; object counts unchanged)", async () => {
    await db.exec(NEWBANK);
    const again = await snapshot();
    assert(JSON.stringify(after003) === JSON.stringify(again), `${JSON.stringify(after003)} vs ${JSON.stringify(again)}`);
    return JSON.stringify(again);
});

// ------------------------------------------------------- catalogue checks ---
const TABLES = ["user_profiles", "qbg_questions", "question_status_transitions", "question_edit_history", "question_translations", "qbg_batches", "qbg_generated_tests", "qbg_generated_test_questions", "pdf_extraction_reports", "ai_reports", "agentic_qc_jobs", "qbg_tasks", "question_video_jobs", "qbg_question_pool", "chapter_merge_log"];
await check("exactly the expected public tables exist", async () => {
    const have = (await all(db, `select tablename from pg_tables where schemaname='public'`)).map((r) => r.tablename);
    const missing = TABLES.filter((t) => !have.includes(t)), extra = have.filter((t) => !TABLES.includes(t));
    assert(!missing.length && !extra.length, `missing=${missing} extra=${extra}`);
    return `${have.length} tables`;
});
await check("RLS enabled on every public table", async () => {
    const off = await all(db, `select relname from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and c.relkind='r' and not c.relrowsecurity`);
    assert(off.length === 0, off.map((r) => r.relname).join(", "));
});
await check("qbg_questions column types match the app contract (difficutly_level kept)", async () => {
    const want = { question_id: "uuid", qbg_id: "text", question_text: "text", options: "jsonb", answer_key: "jsonb", solution_text: "text", question_type: "text", subject: "text", chapter: "text", topic: "text", subtopic: "text", source: "text", difficutly_level: "text", class_level: "text", exam: "ARRAY", parent_question_id: "text", child_order: "smallint", raw_data: "jsonb", source_docx: "jsonb", status: "USER-DEFINED", created_by: "uuid", last_modified_by: "uuid", last_modified_at: "timestamp with time zone" };
    const cols = await all(db, `select column_name, data_type from information_schema.columns where table_schema='public' and table_name='qbg_questions'`);
    const got = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
    const bad = Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k}: want ${v} got ${got[k]}`);
    const extra = Object.keys(got).filter((k) => !(k in want));
    assert(!bad.length && !extra.length, `${bad.join("; ")} extra=${extra}`);
});
await check("user_role enum = the app's ALL_ROLES", async () => {
    const vals = (await all(db, `select unnest(enum_range(null::public.user_role))::text v`)).map((r) => r.v);
    assert(JSON.stringify([...vals].sort()) === JSON.stringify([...ALL_ROLES].sort()), `db=${vals} app=${ALL_ROLES}`);
});
await check("SQL role_permissions() equals ROLE_PERMISSIONS in src/lib/auth/permissions.ts", async () => {
    const drift = [];
    for (const role of ALL_ROLES) {
        const sqlPerms = (await one(db, `select public.role_permissions($1::public.user_role) p`, [role])).p;
        const a = [...sqlPerms].sort().join(","), b = [...ROLE_PERMISSIONS[role]].sort().join(",");
        if (a !== b) drift.push(`${role}: sql[${a}] app[${b}]`);
    }
    assert(!drift.length, drift.join(" | "));
    return `${ALL_ROLES.length} roles identical`;
});
await check("no duplicate indexes", async () => {
    const dup = await all(db, `select indrelid::regclass::text t from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' group by indrelid, indkey::text, indclass::text, coalesce(indexprs::text,''), coalesce(indpred::text,'') having count(*) > 1`);
    assert(dup.length === 0, JSON.stringify(dup));
});
await check("every FK ON DELETE action is valid", async () => {
    const rows = await all(db, `select conrelid::regclass::text tbl, confrelid::regclass::text ref, confdeltype from pg_constraint where contype='f' and connamespace='public'::regnamespace order by 1,2`);
    const map = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
    return rows.map((r) => `${r.tbl}->${r.ref}: ${map[r.confdeltype]}`).join(" | ");
});

// ------------------------------------------------------- anon: nothing -------
await check("anon holds no privilege on any public table, sequence or function", async () => {
    const t = await n(db, `select count(*) n from information_schema.role_table_grants where grantee in ('anon','PUBLIC') and table_schema='public'`);
    const f = await n(db, `select count(*) n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and has_function_privilege('anon', p.oid, 'EXECUTE')`);
    assert(t === 0 && f === 0, `table grants ${t}, executable functions ${f}`);
});
await check("no policy (public or storage) applies to anon or PUBLIC", async () => {
    const rows = await all(db, `select schemaname||'.'||tablename||':'||policyname p from pg_policies where schemaname in ('public','storage') and (roles && array['anon','public']::name[])`);
    assert(rows.length === 0, rows.map((r) => r.p).join(", "));
});
await check("anon cannot read or write any table", async () => as(db, "anon", null, async () => {
    for (const t of TABLES) await expectError(db, `select 1 from public.${t} limit 1`, [], "42501");
    await expectError(db, `insert into public.qbg_questions (question_text) values ('x')`, [], "42501");
    return `${TABLES.length} tables denied`;
}));
await check("anon cannot call the permission / restore functions", async () => as(db, "anon", null, async () => {
    await expectError(db, `select public.has_any_permission(array['view_questions'])`, [], "42501");
    await expectError(db, `select public.admin_restore_question_version(gen_random_uuid())`, [], "42501");
}));
await check("the direct auth-schema user creator is gone", async () => {
    assert((await n(db, `select count(*) n from pg_proc where proname='admin_create_user_with_role'`)) === 0, "still defined");
});

// ------------------------------------------------------------ fixtures -----
const U = {
    admin: "aaaaaaaa-0000-4000-8000-000000000001", manager: "aaaaaaaa-0000-4000-8000-000000000002",
    reviewer: "aaaaaaaa-0000-4000-8000-000000000003", entry: "aaaaaaaa-0000-4000-8000-000000000004",
    viewer: "aaaaaaaa-0000-4000-8000-000000000005", ai: "aaaaaaaa-0000-4000-8000-000000000006",
    fresh: "aaaaaaaa-0000-4000-8000-000000000007",
};
const ROLE_OF = { admin: "admin", manager: "manager", reviewer: "qc_reviewer", entry: "data_entry", viewer: "viewer", ai: "ai_user" };
await check("new auth users get the no-access default role ('custom')", async () => {
    for (const [k, id] of Object.entries(U)) await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${k}@example.test`]);
    const roles = (await all(db, `select role::text r from public.user_profiles`)).map((r) => r.r);
    assert(roles.length === 7 && roles.every((r) => r === "custom"), JSON.stringify(roles));
    for (const [k, role] of Object.entries(ROLE_OF)) await db.query(`update public.user_profiles set role=$2 where user_id=$1`, [U[k], role]); // fixture setup as postgres
});
await check("has_any_permission: roles + extra_permissions, false for a fresh account", async () => {
    const hp = (who, p) => as(db, "authenticated", U[who], async () => (await one(db, `select public.has_any_permission($1) v`, [p])).v);
    assert(await hp("viewer", ["view_questions"]) === true, "viewer view");
    assert(await hp("viewer", ["manual_question_entry"]) === false, "viewer entry");
    assert(await hp("fresh", ["view_questions"]) === false, "fresh account must see nothing");
    await db.query(`update public.user_profiles set extra_permissions='{use_qbg}' where user_id=$1`, [U.viewer]);
    assert(await hp("viewer", ["use_qbg"]) === true, "extra permission");
    await db.query(`update public.user_profiles set extra_permissions='{}' where user_id=$1`, [U.viewer]);
});

// ------------------------------------------------------ server (service_role) --
const Q = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const opts = JSON.stringify([{ text: "a", isCorrect: true }, { text: "b", isCorrect: false }]);
const insertQ = `insert into public.qbg_questions (question_id, qbg_id, question_text, options, answer_key, solution_text, question_type, subject, chapter, topic, source, difficutly_level, exam, parent_question_id, created_by, last_modified_by)
    values ($1::uuid,$1::text,$2,$3::jsonb,$4::jsonb,'<p>sol</p>',$5,'Chemistry','Atomic Structure','Bohr','Paper','Medium',$6::text[],$7,$8,$8)`;
await check("service_role: ingestion-shaped inserts (all answer_key shapes) + creator attribution", () => as(db, "service_role", null, async () => {
    await db.query(insertQ, [Q[0], "<p>Q one</p>", opts, "2", "Single_Choice(SCQ)", ["JEE Mains"], null, U.entry]);
    await db.query(insertQ, [Q[1], "<p>Q two</p>", opts, "[1,2]", "Multi_Choice(MCQ)", null, null, null]);
    await db.query(insertQ, [Q[2], "<p>Q three</p>", "[]", '"3.14"', "Numerical", ["JEE Advanced"], Q[0], null]);
    await db.query(insertQ, [Q[3], "<p>Q four</p>", "[]", null, "Numerical", null, "el9dtimjg18xf49stwcr2fvv4", null]);
    const h = await one(db, `select editor_user_id, editor_email from public.question_edit_history where question_id=$1`, [Q[0]]);
    assert(h.editor_user_id === U.entry && h.editor_email === "entry@example.test", `attribution ${JSON.stringify(h)}`);
    const none = await one(db, `select editor_user_id from public.question_edit_history where question_id=$1`, [Q[1]]);
    assert(none.editor_user_id === null, "no creator -> no editor");
}));
await check("service_role: an update that does not set last_modified_by is not attributed to a previous editor", () => as(db, "service_role", null, async () => {
    await db.query(`update public.qbg_questions set chapter='Atomic structure' where question_id=$1`, [Q[0]]); // e.g. chapter merge
    const h = await one(db, `select editor_user_id from public.question_edit_history where question_id=$1 and change_type='update' order by created_at desc limit 1`, [Q[0]]);
    assert(h.editor_user_id === null, `misattributed to ${h.editor_user_id}`);
    await db.query(`update public.qbg_questions set chapter='Atomic Structure', last_modified_by=$2 where question_id=$1`, [Q[0], U.manager]);
    const h2 = await one(db, `select editor_user_id from public.question_edit_history where question_id=$1 and change_type='update' order by created_at desc limit 1`, [Q[0]]);
    assert(h2.editor_user_id === U.manager, "explicit last_modified_by attributed");
}));
await check("service_role: list/filter query shapes from questions.ts", () => as(db, "service_role", null, async () => {
    const c = await n(db, `select count(*) n from public.qbg_questions where subject = any($1) and exam && $2::text[] and status::text = any($3)`, [["Chemistry"], ["JEE Mains", "NEET"], ["verification_pending"]]);
    const kids = await n(db, `select count(*) n from public.qbg_questions where parent_question_id = $1`, [Q[0]]);
    assert(c === 1 && kids === 1, `${c}/${kids}`);
}));
await check("service_role: server-only tables (tests, tasks, QC jobs, pool, merge log) + pool facets", () => as(db, "service_role", null, async () => {
    const b = (await one(db, `insert into public.qbg_batches (name) values ('Batch A') returning id`)).id;
    const t = (await one(db, `insert into public.qbg_generated_tests (batch_id, batch_name, exam_preset, test_name, language) values ($1,'Batch A','JEE_MAINS','Mock 1','hindi') returning id`, [b])).id;
    await db.query(`insert into public.qbg_generated_test_questions (generated_test_id, question_id, question_order) values ($1,$2,1), ($1,'pipeline-3',2)`, [t, Q[0]]);
    await db.query(`insert into public.qbg_tasks (id, user_id, task_type) values ('9f86d081884c7d659a','dev','qbg_ingestion')`);
    await db.query(`insert into public.agentic_qc_jobs (id, user_id, status) values (gen_random_uuid(), $1, 'queued')`, [U.ai]);
    await db.query(`insert into public.qbg_question_pool (unique_id, subject, chapter, class_level, used_in_exam) values ('4ii5mxgv84bkvg16rv8akjy1j','Chemistry','Mole Concept','11','{Batch A}')`);
    await db.query(`insert into public.chapter_merge_log (table_name, from_chapter, to_chapter, rows_changed) values ('qbg_questions','a','b',1)`);
    const f = (await one(db, `select public.qbg_pool_filter_options() f`)).f;
    assert(f.batchNames[0] === "Batch A" && f.chaptersBySubjectClass["11"].Chemistry[0] === "Mole Concept", JSON.stringify(f));
}));
await check("authenticated users (even admins) cannot touch server-only tables directly", () => as(db, "authenticated", U.admin, async () => {
    for (const tb of ["qbg_batches", "qbg_generated_tests", "qbg_generated_test_questions", "qbg_tasks", "agentic_qc_jobs", "qbg_question_pool", "chapter_merge_log"]) await expectError(db, `select 1 from public.${tb} limit 1`, [], "42501");
    await expectError(db, `select public.qbg_pool_filter_options()`, [], "42501");
}));

// ------------------------------------------------------ question permissions --
await check("qbg_questions: viewer reads, cannot write; fresh account sees nothing", async () => {
    const seen = await as(db, "authenticated", U.viewer, () => n(db, `select count(*) n from public.qbg_questions`));
    assert(seen === 4, `viewer sees ${seen}`);
    await as(db, "authenticated", U.viewer, () => expectError(db, `insert into public.qbg_questions (question_text) values ('x')`, [], "42501"));
    const upd = await as(db, "authenticated", U.viewer, () => db.query(`update public.qbg_questions set chapter='X' where question_id=$1`, [Q[0]]));
    assert(upd.affectedRows === 0, "viewer update must affect 0 rows");
    const fresh = await as(db, "authenticated", U.fresh, () => n(db, `select count(*) n from public.qbg_questions`));
    assert(fresh === 0, `fresh account sees ${fresh}`);
});
await check("qbg_questions: data entry creates (editor recorded), reviewer edits, nobody deletes", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    await as(db, "authenticated", U.entry, () => db.query(`insert into public.qbg_questions (question_id, qbg_id, question_text, created_by, last_modified_by) values ($1::uuid,$1::text,'<p>new</p>',$2,$2)`, [id, U.entry]));
    const h = await one(db, `select editor_user_id, change_type from public.question_edit_history where question_id=$1`, [id]);
    assert(h.editor_user_id === U.entry && h.change_type === "create", JSON.stringify(h));
    const r = await as(db, "authenticated", U.reviewer, () => db.query(`update public.qbg_questions set status='verified', last_modified_by=$2 where question_id=$1`, [id, U.reviewer]));
    assert(r.affectedRows === 1, "reviewer update");
    await as(db, "authenticated", U.admin, () => expectError(db, `delete from public.qbg_questions where question_id=$1`, [id], "42501"));
});
await check("status transitions: reviewer logs as self only; history readable by viewers", async () => {
    await as(db, "authenticated", U.reviewer, () => db.query(`insert into public.question_status_transitions (question_id, to_status, actor_user_id) values ($1,'verified',$2)`, [Q[0], U.reviewer]));
    await as(db, "authenticated", U.reviewer, () => expectError(db, `insert into public.question_status_transitions (question_id, to_status, actor_user_id) values ($1,'verified',$2)`, [Q[0], U.admin], "42501"));
    await as(db, "authenticated", U.viewer, () => expectError(db, `insert into public.question_status_transitions (question_id, to_status, actor_user_id) values ($1,'verified',$2)`, [Q[0], U.viewer], "42501"));
    const hist = await as(db, "authenticated", U.viewer, () => n(db, `select count(*) n from public.question_edit_history where question_id=$1`, [Q[0]]));
    assert(hist >= 3, `viewer sees ${hist} history rows`);
    await as(db, "authenticated", U.admin, () => expectError(db, `insert into public.question_edit_history (question_id, change_type, snapshot) values ($1,'update','{}')`, [Q[0]], "42501"));
});
await check("restore RPC: admin restores (as 'restore'), others rejected", async () => {
    const hid = (await one(db, `select id from public.question_edit_history where question_id=$1 and change_type='create'`, [Q[3]])).id;
    await as(db, "authenticated", U.manager, () => expectError(db, `select public.admin_restore_question_version($1)`, [hid], "42501"));
    await as(db, "authenticated", U.admin, () => db.query(`select public.admin_restore_question_version($1, 'test')`, [hid]));
    const last = await one(db, `select change_type, editor_user_id from public.question_edit_history where question_id=$1 order by created_at desc limit 1`, [Q[3]]);
    assert(last.change_type === "restore" && last.editor_user_id === U.admin, JSON.stringify(last));
});

// ------------------------------------------------------------ translations --
await check("translations: AI user inserts/sets default/deletes; viewer reads only; fresh sees none", async () => {
    const ins = `insert into public.question_translations (question_id, language, question_text, translated_by) values ($1,'hindi',$2,$3) returning id`;
    const t1 = (await as(db, "authenticated", U.ai, () => one(db, ins, [Q[0], "v1", U.ai]))).id;
    const t2 = (await as(db, "authenticated", U.ai, () => one(db, ins, [Q[0], "v2", U.ai]))).id;
    await as(db, "authenticated", U.ai, () => db.query(`update public.question_translations set is_default=true where id=$1`, [t1]));
    const d = await all(db, `select id from public.question_translations where question_id=$1 and is_default`, [Q[0]]);
    assert(d.length === 1 && d[0].id === t1, "default flip");
    assert((await as(db, "authenticated", U.viewer, () => n(db, `select count(*) n from public.question_translations`))) === 2, "viewer read");
    const del = await as(db, "authenticated", U.viewer, () => db.query(`delete from public.question_translations where id=$1`, [t2]));
    assert(del.affectedRows === 0, "viewer delete must affect 0 rows");
    await as(db, "authenticated", U.viewer, () => expectError(db, ins, [Q[0], "x", U.viewer], "42501"));
    assert((await as(db, "authenticated", U.fresh, () => n(db, `select count(*) n from public.question_translations`))) === 0, "fresh read");
    await as(db, "authenticated", U.ai, () => db.query(`delete from public.question_translations where id=$1`, [t2]));
});

// ------------------------------------------------ owner-scoped user data --
await check("extraction reports: owner + admin/manager; other users see nothing", async () => {
    const id = (await as(db, "authenticated", U.entry, () => expectError(db, `insert into public.pdf_extraction_reports (user_id, source_name, mode, provider) values ($1,'P','single','p') returning id`, [U.entry], "42501")));
    assert(id, "data_entry lacks upload_pdf");
    const rid = (await as(db, "authenticated", U.manager, () => one(db, `insert into public.pdf_extraction_reports (user_id, source_name, mode, provider) values ($1,'P','single','p') returning id`, [U.manager]))).id;
    await as(db, "authenticated", U.manager, () => expectError(db, `insert into public.pdf_extraction_reports (user_id, source_name, mode, provider) values ($1,'P','single','p')`, [U.ai], "42501"));
    assert((await as(db, "authenticated", U.ai, () => n(db, `select count(*) n from public.pdf_extraction_reports`))) === 0, "other user");
    assert((await as(db, "authenticated", U.admin, () => n(db, `select count(*) n from public.pdf_extraction_reports`))) === 1, "admin");
    const u = await as(db, "authenticated", U.manager, () => db.query(`update public.pdf_extraction_reports set status='completed' where id=$1`, [rid]));
    assert(u.affectedRows === 1, "owner update");
});
await check("ai_reports: owner only; all 10 app report types accepted", async () => {
    for (const t of ["qc", "solution", "modification", "repeat_check", "extraction", "translate", "video", "qbg_ingestion", "qbg_modification", "qbg_tagging"])
        await as(db, "authenticated", U.ai, () => db.query(`insert into public.ai_reports (user_id, report_type) values ($1,$2)`, [U.ai, t]));
    await as(db, "authenticated", U.ai, () => expectError(db, `insert into public.ai_reports (user_id, report_type) values ($1,'bogus')`, [U.ai], "23514"));
    await as(db, "authenticated", U.ai, () => expectError(db, `insert into public.ai_reports (user_id, report_type) values ($1,'qc')`, [U.viewer], "42501"));
    assert((await as(db, "authenticated", U.admin, () => n(db, `select count(*) n from public.ai_reports`))) === 0, "even admin sees only own reports");
    assert((await as(db, "authenticated", U.ai, () => n(db, `select count(*) n from public.ai_reports`))) === 10, "owner sees own");
});
await check("question_video_jobs: owner only; needs use_question_wise_videos to create", async () => {
    const jid = (await as(db, "authenticated", U.ai, () => one(db, `insert into public.question_video_jobs (user_id, source_url) values ($1,'https://x') returning id`, [U.ai]))).id;
    await as(db, "authenticated", U.viewer, () => expectError(db, `insert into public.question_video_jobs (user_id, source_url) values ($1,'https://x')`, [U.viewer], "42501"));
    assert((await as(db, "authenticated", U.manager, () => n(db, `select count(*) n from public.question_video_jobs`))) === 0, "others see none");
    const u = await as(db, "authenticated", U.ai, () => db.query(`update public.question_video_jobs set status='detecting' where id=$1`, [jid]));
    assert(u.affectedRows === 1, "owner update");
});
await check("user_profiles: self read, admin read-all/update, no self-promotion, email not writable", async () => {
    assert((await as(db, "authenticated", U.viewer, () => n(db, `select count(*) n from public.user_profiles`))) === 1, "self only");
    assert((await as(db, "authenticated", U.admin, () => n(db, `select count(*) n from public.user_profiles`))) === 7, "admin all");
    const p = await as(db, "authenticated", U.viewer, () => db.query(`update public.user_profiles set role='admin' where user_id=$1`, [U.viewer]));
    assert(p.affectedRows === 0, "self-promotion must affect 0 rows");
    const a = await as(db, "authenticated", U.admin, () => db.query(`update public.user_profiles set role='viewer', extra_permissions='{use_qbg}' where user_id=$1`, [U.fresh]));
    assert(a.affectedRows === 1, "admin update");
    await as(db, "authenticated", U.admin, () => expectError(db, `update public.user_profiles set email='x' where user_id=$1`, [U.fresh], "42501"));
    await db.query(`update public.user_profiles set role='custom', extra_permissions='{}' where user_id=$1`, [U.fresh]);
});

// ------------------------------------------------------------- storage -----
await check("storage: 4 private buckets; per-user video folders; docx-media by permission; anon nothing", async () => {
    const b = await all(db, `select id, public from storage.buckets order by id`);
    assert(b.length === 4 && b.every((x) => x.public === false), JSON.stringify(b));
    assert(b.map((x) => x.id).join(",") === "ai-video-artifacts,docx-media,question-media,question-video-artifacts", JSON.stringify(b));
    const put = (bucket, name) => `insert into storage.objects (bucket_id, name) values ('${bucket}', '${name}')`;
    await as(db, "authenticated", U.ai, () => db.query(put("question-video-artifacts", `${U.ai}/job1/clips.zip`)));
    await as(db, "authenticated", U.ai, () => expectError(db, put("question-video-artifacts", `${U.manager}/job1/clips.zip`), [], "42501"));
    await as(db, "authenticated", U.ai, () => db.query(put("ai-video-artifacts", `${U.ai}/job2/v.zip`)));
    assert((await as(db, "authenticated", U.manager, () => n(db, `select count(*) n from storage.objects where bucket_id in ('question-video-artifacts','ai-video-artifacts')`))) === 0, "others' video artifacts hidden");
    await as(db, "authenticated", U.manager, () => db.query(put("docx-media", "ext1/questions/abc.png")));
    await as(db, "authenticated", U.entry, () => expectError(db, put("docx-media", "ext1/questions/def.png"), [], "42501"));
    assert((await as(db, "authenticated", U.viewer, () => n(db, `select count(*) n from storage.objects where bucket_id='docx-media'`))) === 1, "viewer reads docx media");
    assert((await as(db, "authenticated", U.fresh, () => n(db, `select count(*) n from storage.objects`))) === 0, "fresh reads nothing");
    await as(db, "anon", null, async () => {
        await expectError(db, put("docx-media", "x/y.png"), [], "42501");
        assert((await n(db, `select count(*) n from storage.objects`)) === 0, "anon reads nothing");
    });
});

// ------------------------------------------ 003: new question bank support ---
const C1 = "66666666-6666-4666-8666-666666666661", C2 = "66666666-6666-4666-8666-666666666662";
const insertChild = `insert into public.qbg_questions (question_id, qbg_id, question_text, question_type, parent_question_id, child_order) values ($1::uuid, $1::text, $2, 'Integer', $3, $4)`;
await check("003 child_order: needs a parent, starts at 1, unique per parent, deferrable swap, ordering", () => as(db, "service_role", null, async () => {
    await db.query(insertChild, [C1, "<p>child 1</p>", Q[0], 1]);
    await db.query(insertChild, [C2, "<p>child 2</p>", Q[0], 2]);
    await expectError(db, insertChild, ["66666666-6666-4666-8666-666666666663", "<p>dup</p>", Q[0], 1], "23505");
    await expectError(db, insertChild, ["66666666-6666-4666-8666-666666666664", "<p>no parent</p>", null, 1], "23514");
    await expectError(db, insertChild, ["66666666-6666-4666-8666-666666666665", "<p>zero</p>", Q[0], 0], "23514");
    // same position under a different parent is fine; NULL positions never collide
    await db.query(insertChild, ["66666666-6666-4666-8666-666666666666", "<p>other parent</p>", Q[1], 1]);
    await db.query(`delete from public.qbg_questions where question_id = '66666666-6666-4666-8666-666666666666'`);
    // swap positions in one transaction
    await db.exec(`begin;
        set constraints public.qbg_questions_parent_child_order_key deferred;
        update public.qbg_questions set child_order = 2 where question_id = '${C1}';
        update public.qbg_questions set child_order = 1 where question_id = '${C2}';
        commit;`);
    // the fetchChildQuestions() order: child_order asc nulls last, then question_id (Q[2] has no position)
    const kids = (await all(db, `select question_id from public.qbg_questions where parent_question_id = $1 order by child_order asc nulls last, question_id`, [Q[0]])).map((r) => r.question_id);
    assert(JSON.stringify(kids) === JSON.stringify([C2, C1, Q[2]]), JSON.stringify(kids));
    await db.exec(`begin; set constraints public.qbg_questions_parent_child_order_key deferred;
        update public.qbg_questions set child_order = 1 where question_id = '${C1}';
        update public.qbg_questions set child_order = 2 where question_id = '${C2}'; commit;`);
    return `order ${kids.length} children ok`;
}));
await check("003 restore RPC also restores child_order (and is still admin-only)", async () => {
    const hid = (await one(db, `select id from public.question_edit_history where question_id=$1 and change_type='create'`, [C1])).id; // snapshot: child_order = 1
    await as(db, "service_role", null, () => db.query(`update public.qbg_questions set child_order = 9 where question_id = $1`, [C1]));
    await as(db, "authenticated", U.manager, () => expectError(db, `select public.admin_restore_question_version($1)`, [hid], "42501"));
    await as(db, "authenticated", U.admin, () => db.query(`select public.admin_restore_question_version($1)`, [hid]));
    const r = await one(db, `select child_order from public.qbg_questions where question_id = $1`, [C1]);
    assert(r.child_order === 1, `restored child_order = ${r.child_order}`);
    await as(db, "anon", null, () => expectError(db, `select public.admin_restore_question_version($1)`, [hid], "42501"));
});
await check("003 question-media: private + limits; uploads only by question creators/editors to newbank/<existing question>/<file>", async () => {
    const b = await one(db, `select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'question-media'`);
    assert(b.public === false && Number(b.file_size_limit) === 10485760 && JSON.stringify(b.allowed_mime_types) === JSON.stringify(["image/png", "image/jpeg", "image/gif", "image/webp"]), JSON.stringify(b));
    const put = (name) => `insert into storage.objects (bucket_id, name) values ('question-media', '${name}')`;
    // allowed: upload_pdf (manager), manual_question_entry (data entry), edit_metadata (reviewer)
    await as(db, "authenticated", U.manager, () => db.query(put(`newbank/${Q[0]}/fig-1.png`)));
    await as(db, "authenticated", U.entry, () => db.query(put(`newbank/${Q[1]}/diagram_a.JPG`)));
    await as(db, "authenticated", U.reviewer, () => db.query(put(`newbank/${Q[0]}/fix-2.webp`)));
    // refused: read-only roles
    const refused = async (who, p) => {
        try { await as(db, "authenticated", U[who], () => expectError(db, put(p), [], "42501")); }
        catch (e) { throw new Error(`${who} -> ${p}: ${e.message}`); }
    };
    for (const who of ["viewer", "ai", "fresh"]) await refused(who, `newbank/${Q[0]}/x-${who}.png`);
    // refused: paths outside the convention, SVG, unknown question, non-canonical (upper-case) uuid
    const HEX = "abcdef01-2345-4678-89ab-cdef01234567";
    await as(db, "service_role", null, () => db.query(`insert into public.qbg_questions (question_id, qbg_id, question_text) values ($1::uuid, $1::text, '<p>hex id</p>')`, [HEX]));
    const badPaths = [`other/${Q[0]}/x.png`, `newbank/not-a-uuid/x.png`, `newbank/${Q[0]}/x.svg`, `newbank/${Q[0]}/sub/x.png`, `newbank/${Q[0]}/.hidden.png`, `newbank/${Q[0]}/x.pdf`, `newbank/99999999-9999-4999-8999-999999999999/x.png`, `newbank/${HEX.toUpperCase()}/x.png`];
    for (const p of badPaths) await refused("manager", p);
    // reads follow the qbg_questions SELECT permissions
    const seen = (who) => as(db, "authenticated", U[who], () => n(db, `select count(*) n from storage.objects where bucket_id = 'question-media'`));
    assert((await seen("viewer")) === 3, "viewer reads");
    assert((await seen("fresh")) === 0, "fresh account reads nothing");
    // immutable for users: no update / delete policy -> 0 rows affected
    const upd = await as(db, "authenticated", U.admin, () => db.query(`update storage.objects set name = name || '.x' where bucket_id = 'question-media'`));
    const del = await as(db, "authenticated", U.admin, () => db.query(`delete from storage.objects where bucket_id = 'question-media'`));
    assert(upd.affectedRows === 0 && del.affectedRows === 0, `update ${upd.affectedRows} / delete ${del.affectedRows}`);
    await as(db, "anon", null, async () => {
        await expectError(db, put(`newbank/${Q[0]}/anon.png`), [], "42501");
        assert((await n(db, `select count(*) n from storage.objects where bucket_id = 'question-media'`)) === 0, "anon reads nothing");
    });
    return `3 uploads allowed, ${badPaths.length + 3} refused`;
});

// ------------------------------------------------------- FK side effects ---
await check("deleting an auth user nulls audit columns and cascades profile", async () => {
    await db.query(`delete from auth.users where id=$1`, [U.entry]);
    const q = await one(db, `select created_by from public.qbg_questions where question_id=$1`, [Q[0]]);
    assert(q.created_by === null, "created_by nulled");
    assert((await n(db, `select count(*) n from public.user_profiles where user_id=$1`, [U.entry])) === 0, "profile cascaded");
});

// ---------------------------------------------------- post-import backfill --
await check("001 backfills: status + raw_data translations, idempotent on re-run", async () => {
    const raw = JSON.stringify([{ verification_status: 1, ai_metadata: { translations: [
        { targetLanguage: "Hindi", translatedQuestionText: "old", translatedAt: "2025-01-01T00:00:00Z" },
        { targetLanguage: "Hindi", translatedQuestionText: "new", translatedAt: "2025-02-01T00:00:00Z" },
        { targetLanguage: "Tamil", translatedQuestionText: "t", translatedAt: "not a date" },
    ] } }]);
    const id = (await one(db, `insert into public.qbg_questions (question_text, raw_data) values ('imported', $1::jsonb) returning question_id`, [raw])).question_id;
    await db.exec(BACKFILL);
    const c1 = await n(db, `select count(*) n from public.question_translations where question_id=$1`, [id]);
    const def = await one(db, `select question_text from public.question_translations where question_id=$1 and language='hindi' and is_default`, [id]);
    const st = (await one(db, `select status::text s from public.qbg_questions where question_id=$1`, [id])).s;
    await db.query(`update public.qbg_questions set status='rejected' where question_id=$1`, [id]);
    await db.exec(BACKFILL);
    const c2 = await n(db, `select count(*) n from public.question_translations where question_id=$1`, [id]);
    const st2 = (await one(db, `select status::text s from public.qbg_questions where question_id=$1`, [id])).s;
    assert(c1 === 3 && c2 === 3 && def.question_text === "new" && st === "verified" && st2 === "rejected", JSON.stringify({ c1, c2, def, st, st2 }));
});

// ------------------------------------------------ upgrade over old enum ----
await check("000 applies over a user_role enum created by the original 5-value migration", async () => {
    const old = new PGlite({ extensions: { pgcrypto } });
    await old.exec(SHIM);
    await old.exec(`create type public.user_role as enum ('admin','manager','data_entry','ai_user','viewer')`);
    await old.exec(REBUILD);
    const cnt = await n(old, `select count(*) n from unnest(enum_range(null::public.user_role))`);
    await old.close();
    assert(cnt === 11, `${cnt} values`);
});

await check("002_verify_bootstrap.sql reports all PASS on a fresh bootstrap", async () => {
    const fresh = new PGlite({ extensions: { pgcrypto } });
    await fresh.exec(SHIM);
    await fresh.exec(REBUILD);
    const rows = (await fresh.query(read(path.join(sqlDir, "002_verify_bootstrap.sql")))).rows;
    await fresh.close();
    const failed = rows.filter((r) => r.result !== "PASS");
    assert(rows.length >= 13 && !failed.length, failed.map((r) => `${r.check_name}: ${r.detail}`).join("; "));
    return `${rows.length} checks PASS`;
});

await check("003_verify_new_question_bank_support.sql: all PASS after 000 + 003, and after 000 -> 003 -> 000 -> 003", async () => {
    const fresh = new PGlite({ extensions: { pgcrypto } });
    await fresh.exec(SHIM);
    await fresh.exec(REBUILD);
    await fresh.exec(NEWBANK);
    const verify = async () => (await fresh.query(NEWBANK_VERIFY)).rows;
    const r1 = await verify();
    const bootstrap = (await fresh.query(read(path.join(sqlDir, "002_verify_bootstrap.sql")))).rows;
    // re-running 000 reverts the restore function; the verify script must notice, and 003 must repair it
    await fresh.exec(REBUILD);
    const stale = (await verify()).find((r) => r.check_name.startsWith("admin_restore_question_version restores child_order"));
    await fresh.exec(NEWBANK);
    const r2 = await verify();
    await fresh.close();
    const bad = [...r1, ...r2].filter((r) => r.result !== "PASS");
    assert(r1.length >= 9 && !bad.length, bad.map((r) => `${r.check_name}: ${r.detail}`).join("; "));
    assert(stale?.result === "FAIL", "verify must flag a 000 re-run");
    const b = bootstrap.filter((r) => r.result !== "PASS");
    assert(!b.length, `002 after 003: ${b.map((r) => r.check_name).join("; ")}`);
    return `${r1.length} checks PASS; 002 still PASS after 003; a 000 re-run is detected and repaired by 003`;
});

await db.close();

// --------------------------------------------------------------- report ----
console.log(`PostgreSQL: ${version}\n`);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? `\n      ${r.note}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
