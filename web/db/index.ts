import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");

// One pooled client per process; Next dev re-evaluates modules, so cache it on globalThis.
const g = globalThis as unknown as { __teenpehrSql?: ReturnType<typeof postgres> };
const sql = g.__teenpehrSql ?? postgres(url, { max: 10, prepare: false });
if (process.env.NODE_ENV !== "production") g.__teenpehrSql = sql;

export const db = drizzle(sql, { schema });
export type Db = typeof db;
export { schema };
