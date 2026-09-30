#!/usr/bin/env node
/*
 * Database migrations at container start (docs/DEPLOY.md). scripts/docker-entrypoint.sh runs this before
 * `node server.js`; it needs only drizzle-orm and postgres (runtime dependencies), not drizzle-kit.
 *
 *   DATABASE_URL=… node scripts/migrate.mjs             # bring the database up to db/migrations
 *   DATABASE_URL=… node scripts/migrate.mjs --dry-run   # say what it would do; change nothing
 *
 * Three cases, decided under an advisory lock (two containers starting at once take turns):
 * - The journal (drizzle.__drizzle_migrations, the table `npm run db:migrate` keeps) has rows: apply the
 *   migrations newer than its last one, as drizzle-kit would. Usually none.
 * - No journal rows and no tables in `public`: a new database; apply every migration.
 * - No journal rows but tables in `public`: a database built with `npm run db:push` (the laptop's, restored
 *   from a dump). Its tables exist, so running 0001_baseline would fail. Its structure is compared with the
 *   schema snapshot drizzle-kit saved for each migration (db/migrations/meta/*_snapshot.json), newest first;
 *   on an exact match with migration N, migrations 0..N are recorded as applied WITHOUT running them (their
 *   data changes are the ones `npm run db:backfill` makes on a pushed database) and any later ones are then
 *   applied normally. No match: nothing is written, the differences are printed, and the exit code is 1, so
 *   the container stops before the server starts.
 *
 * Compared: tables; columns (type, not null, generated); primary keys; indexes (name, unique, method); foreign
 * keys (name, on delete); unique and check constraints (by name); enums and their values; the pg_trgm
 * extension and immutable_array_join() from 0000_extensions. Not compared: column defaults and index or check
 * expressions, which drizzle-kit and Postgres spell differently. Every migration changes something compared,
 * except the data-only ones, whose snapshot equals the one before (the newest equal snapshot is taken).
 * After migrating, the database is compared with the newest snapshot once more; a difference is a warning.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

const DIR = resolve(process.env.MIGRATIONS_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations"));
const JOURNAL_SCHEMA = "drizzle"; // drizzle-kit's defaults, so `npm run db:migrate` and this share one journal
const JOURNAL_TABLE = "__drizzle_migrations";
const LOCK_KEY = 7_401_190_613; // any constant; pg_advisory_lock(bigint)
const WAIT_S = Number(process.env.MIGRATE_WAIT_S || 60);
const dryRun = process.argv.includes("--dry-run");

const log = (msg) => console.log(`migrate: ${msg}`);
const fail = (msg) => { console.error(`migrate: ${msg}`); process.exitCode = 1; };

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) return fail("DATABASE_URL is not set");
  const journal = JSON.parse(readFileSync(join(DIR, "meta", "_journal.json"), "utf8"));
  const files = readMigrationFiles({ migrationsFolder: DIR }); // same order, hashes and times as drizzle's migrate()
  const entries = journal.entries.map((e, i) => ({ tag: e.tag, when: e.when, hash: files[i].hash }));
  const latest = entries.at(-1);
  const latestShape = snapshotShape(latest.tag); // null if its snapshot was not committed: then nothing to compare with
  if (!latestShape) console.warn(`migrate: warning: no snapshot for ${latest.tag} (db/migrations/meta); its structure cannot be checked`);

  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  try {
    await waitForDatabase(sql);
    const [{ db, version }] = await sql`select current_database() as db, current_setting('server_version') as version`;
    log(`database "${db}" (PostgreSQL ${version}), ${entries.length} migrations in ${DIR}${dryRun ? ", dry run" : ""}`);
    await sql`select pg_advisory_lock(${LOCK_KEY})`;

    let last = await lastApplied(sql);
    if (!last) {
      const tables = await sql`select count(*)::int as n from pg_tables where schemaname = 'public'`;
      if (tables[0].n === 0) {
        log("empty database: applying every migration");
      } else {
        const live = await liveShape(sql);
        const match = findSnapshotMatch(entries, live);
        if (match < 0) {
          fail(`the database has ${tables[0].n} tables but no migration journal, and its structure matches none of the ` +
            `${entries.length} migrations' snapshots, so nothing was changed.${latestShape ? ` Differences from ${latest.tag}:` : ""}`);
          for (const line of latestShape ? diff(latestShape, live) : []) console.error(`  ${line}`);
          console.error("migrate: bring that database up to date where it was built (npm run db:push -- --force && npm run db:backfill; " +
            "after a schema.ts change, npm run db:generate first), then dump and restore it again.");
          return;
        }
        const done = entries.slice(0, match + 1);
        log(`database built with db:push: its structure matches ${entries[match].tag}; recording ${done.map((e) => e.tag).join(", ")} ` +
          "as applied without running them");
        if (!dryRun) await baseline(sql, done);
        last = entries[match].when;
      }
    }

    const pending = entries.filter((e) => last == null || last < e.when);
    if (pending.length === 0) {
      log(`up to date (last applied: ${entries.find((e) => e.when === last)?.tag ?? last}); nothing to do`);
    } else if (dryRun) {
      log(`would apply ${pending.map((e) => e.tag).join(", ")}`);
    } else {
      log(`applying ${pending.map((e) => e.tag).join(", ")}`);
      await migrate(drizzle(sql), { migrationsFolder: DIR, migrationsSchema: JOURNAL_SCHEMA, migrationsTable: JOURNAL_TABLE });
      log(`applied ${pending.length} migration${pending.length === 1 ? "" : "s"}`);
    }

    if (latestShape && (!dryRun || pending.length === 0)) {
      const d = diff(latestShape, await liveShape(sql));
      if (d.length === 0) log(`structure matches ${latest.tag}`);
      else {
        console.warn(`migrate: warning: the structure differs from ${latest.tag}'s snapshot:`);
        for (const line of d) console.warn(`  ${line}`);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Retry the first connection for WAIT_S seconds: the database may still be starting with the stack. */
async function waitForDatabase(sql) {
  const until = Date.now() + WAIT_S * 1000;
  for (let attempt = 1; ; attempt++) {
    try { await sql`select 1`; return; } catch (e) {
      if (Date.now() >= until) throw new Error(`database not reachable after ${WAIT_S} s: ${e.message}`);
      if (attempt === 1 || attempt % 5 === 0) log(`waiting for the database (${e.code ?? e.message})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** created_at of the newest journal row (drizzle's own rule), or null without a journal or rows. */
async function lastApplied(sql) {
  const [t] = await sql`select to_regclass(${`${JOURNAL_SCHEMA}.${JOURNAL_TABLE}`}) is not null as exists`;
  if (!t.exists) return null;
  const rows = await sql`select created_at from ${sql(JOURNAL_SCHEMA)}.${sql(JOURNAL_TABLE)} order by created_at desc limit 1`;
  return rows.length ? Number(rows[0].created_at) : null;
}

/** Record migrations as applied, exactly as drizzle's migrate() would have (same table, hash and time). */
async function baseline(sql, done) {
  await sql.begin(async (tx) => {
    await tx`create schema if not exists ${tx(JOURNAL_SCHEMA)}`;
    await tx`create table if not exists ${tx(JOURNAL_SCHEMA)}.${tx(JOURNAL_TABLE)} (id serial primary key, hash text not null, created_at bigint)`;
    for (const e of done) await tx`insert into ${tx(JOURNAL_SCHEMA)}.${tx(JOURNAL_TABLE)} (hash, created_at) values (${e.hash}, ${e.when})`;
  });
}

/** The newest migration whose snapshot equals the live structure, or -1. */
function findSnapshotMatch(entries, live) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const shape = snapshotShape(entries[i].tag);
    if (shape && diff(shape, live).length === 0) return i;
  }
  return -1;
}

// ---- structure, as a set of comparable lines ----

const SERIAL = { serial: "integer", bigserial: "bigint", smallserial: "smallint" };
const ON_DELETE = { a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" };
const PREREQS = ["extension pg_trgm", "function immutable_array_join"]; // 0000_extensions (db:prepare on a pushed database)
const normType = (t) => (SERIAL[t] ?? t).replace(/^"?public"?\./, "").replace(/"/g, "").replace(/,\s+/g, ",");
const col = (table, name, type, notNull, generated) =>
  `column ${table}.${name} ${normType(type)}${notNull ? " not null" : ""}${generated ? " generated" : ""}`;

/** What the snapshot saved with migration `tag` says the public schema looks like (null when there is none). */
function snapshotShape(tag) {
  const file = join(DIR, "meta", `${tag.split("_")[0]}_snapshot.json`);
  if (!existsSync(file)) return null;
  const snap = JSON.parse(readFileSync(file, "utf8"));
  const out = new Set(PREREQS);
  for (const e of Object.values(snap.enums ?? {})) if ((e.schema || "public") === "public") out.add(`enum ${e.name} (${e.values.join(", ")})`);
  for (const t of Object.values(snap.tables ?? {})) {
    if ((t.schema || "public") !== "public") continue;
    out.add(`table ${t.name}`);
    const pk = [];
    for (const c of Object.values(t.columns)) {
      out.add(col(t.name, c.name, c.type, c.notNull, !!c.generated));
      if (c.primaryKey) pk.push(c.name);
    }
    for (const p of Object.values(t.compositePrimaryKeys ?? {})) pk.push(...p.columns);
    if (pk.length) out.add(`primary key ${t.name} (${pk.join(", ")})`);
    for (const i of Object.values(t.indexes ?? {})) out.add(`index ${t.name}.${i.name}${i.isUnique ? " unique" : ""} using ${i.method ?? "btree"}`);
    for (const f of Object.values(t.foreignKeys ?? {})) out.add(`foreign key ${t.name}.${f.name} on delete ${f.onDelete ?? "no action"}`);
    for (const u of Object.values(t.uniqueConstraints ?? {})) out.add(`unique ${t.name}.${u.name}`);
    for (const c of Object.values(t.checkConstraints ?? {})) out.add(`check ${t.name}.${c.name}`);
  }
  return out;
}

/** The same lines, read from the database's catalogs. */
async function liveShape(sql) {
  const out = new Set();
  const [x] = await sql`select exists (select 1 from pg_extension where extname = 'pg_trgm') as trgm,
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'immutable_array_join') as fn`;
  if (x.trgm) out.add(PREREQS[0]);
  if (x.fn) out.add(PREREQS[1]);
  const enums = await sql`select t.typname::text as name, array_agg(e.enumlabel::text order by e.enumsortorder) as vals
    from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' group by t.typname`;
  for (const e of enums) out.add(`enum ${e.name} (${e.vals.join(", ")})`);
  const cols = await sql`select c.relname::text as tbl, a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type,
      a.attnotnull as not_null, a.attgenerated <> '' as generated
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped`;
  const tables = await sql`select c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')`;
  for (const t of tables) out.add(`table ${t.name}`);
  for (const c of cols) out.add(col(c.tbl, c.name, c.type, c.not_null, c.generated));
  const cons = await sql`select c.relname::text as tbl, con.conname::text as name, con.contype as type, con.confdeltype as del,
      array(select a.attname::text from unnest(con.conkey) with ordinality k(num, ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.num order by k.ord) as cols
    from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and con.contype in ('p', 'u', 'f', 'c')`;
  for (const c of cons) {
    if (c.type === "p") out.add(`primary key ${c.tbl} (${c.cols.join(", ")})`);
    else if (c.type === "u") out.add(`unique ${c.tbl}.${c.name}`);
    else if (c.type === "f") out.add(`foreign key ${c.tbl}.${c.name} on delete ${ON_DELETE[c.del] ?? c.del}`);
    else out.add(`check ${c.tbl}.${c.name}`);
  }
  // Indexes of their own; the ones behind a primary key or unique constraint are covered above.
  const idx = await sql`select t.relname::text as tbl, i.relname::text as name, ix.indisunique as uniq, am.amname::text as method
    from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_class t on t.oid = ix.indrelid
      join pg_namespace n on n.oid = t.relnamespace join pg_am am on am.oid = i.relam
    where n.nspname = 'public' and not exists (select 1 from pg_constraint con where con.conindid = ix.indexrelid and con.contype in ('p', 'u', 'x'))`;
  for (const i of idx) out.add(`index ${i.tbl}.${i.name}${i.uniq ? " unique" : ""} using ${i.method}`);
  return out;
}

/** Lines only one side has: "missing: …" (expected, not in the database) and "unexpected: …". */
function diff(expected, live) {
  const out = [];
  for (const l of [...expected].sort()) if (!live.has(l)) out.push(`missing:    ${l}`);
  for (const l of [...live].sort()) if (!expected.has(l)) out.push(`unexpected: ${l}`);
  return out;
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
