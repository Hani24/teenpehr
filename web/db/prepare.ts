/**
 * What the schema needs before `drizzle-kit push` can create it: the pg_trgm extension and the
 * immutable_array_join() helper behind the generated search columns. It executes
 * db/migrations/0000_extensions.sql, the file `npm run db:migrate` applies first, so push-built and
 * migrated databases end up the same. Idempotent. `npm run db:push` runs it first; alone: npm run db:prepare
 *
 * It connects where drizzle-kit does: DATABASE_URL (drizzle-kit also reads ./.env), else the local
 * default in drizzle.config.ts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env"); // as drizzle-kit's dotenv does; set variables win
  const { default: config } = await import("../drizzle.config");
  const url = (config as { dbCredentials?: { url?: string } }).dbCredentials?.url;
  if (!url) throw new Error("no database URL in drizzle.config.ts");
  const dir = join(process.cwd(), "db", "migrations");
  const file = readdirSync(dir).find((f) => f.startsWith("0000_") && f.endsWith(".sql"));
  if (!file) throw new Error("db/migrations/0000_*.sql is missing");
  const statements = readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    for (const s of statements) await sql.unsafe(s);
    console.log(`db:prepare: ${file} applied (${statements.length} statements)`);
    // One-time, databases pushed before accounts existed: the never-used admin_users table and admin_role
    // enum gave way to users and user_role, and while they exist push stops to ask whether one was renamed
    // (a prompt that fails without a terminal). Dropped only while empty.
    const [old] = await sql<{ n: number }[]>`select count(*)::int as n from admin_users`.catch(() => [null]);
    if (old && old.n > 0) throw new Error("admin_users has rows: accounts now live in users (lib/auth); move them and drop admin_users by hand");
    if (old) { await sql`drop table admin_users`; console.log("db:prepare: dropped the retired admin_users table"); }
    await sql`drop type if exists admin_role`;
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
