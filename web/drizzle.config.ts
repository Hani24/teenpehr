import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://teenpehr:teenpehr@127.0.0.1:5432/teenpehr" },
  strict: true,
  verbose: true,
});
