import "server-only";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/*
 * `next build` evaluates every route module to read its config, so this file runs at build time too. The
 * build needs no database and no secret (the Docker image is built without either, docs/DEPLOY.md): while
 * building, the client points at a socket that does not exist, whatever DATABASE_URL says, so a query fails
 * at once ("connect ENOENT /no-database-during-next-build"). No page queries at build time (each reads the
 * session first, which makes it dynamic); that error only shows if a change makes a database-backed page
 * static by mistake. Nothing changes at run time.
 */
function client(): ReturnType<typeof postgres> {
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return postgres({ path: "/no-database-during-next-build", max: 1 });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  return postgres(url, { max: 10, prepare: false });
}

// One pooled client per process; Next dev re-evaluates modules, so cache it on globalThis.
const g = globalThis as unknown as { __teenpehrSql?: ReturnType<typeof postgres> };
const sql = g.__teenpehrSql ?? client();
if (process.env.NODE_ENV !== "production") g.__teenpehrSql = sql;

export const db = drizzle(sql, { schema });
export type Db = typeof db;
/** A transaction handle (db.transaction's callback argument). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export { schema };
