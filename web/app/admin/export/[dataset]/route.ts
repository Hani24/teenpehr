import { notFound } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { csvLine, DATASETS } from "../_datasets";

export const dynamic = "force-dynamic";
const BATCH = 1000;
const formatParam = z.enum(["csv", "jsonl"]).catch("csv");
/** Postgres timestamptz text ("2026-09-27 21:01:26.1+00") as ISO 8601 UTC; anything else unchanged. */
const PG_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/;
const iso = (v: unknown) => (typeof v === "string" && PG_TS.test(v) ? new Date(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).toISOString() : v);

/**
 * GET /admin/export/{dataset}?format=csv|jsonl: the whole table, streamed in batches. Owner only (the
 * proxy keeps readers out of /admin; this is the check that holds regardless). CSV starts with a BOM so
 * spreadsheets read the Urdu as UTF-8; JSONL is one JSON object per line, values as stored.
 */
export async function GET(req: Request, ctx: { params: Promise<{ dataset: string }> }) {
  const { dataset } = await ctx.params;
  await requireRole("owner", { locale: "en", next: `/admin/export` });
  const def = Object.hasOwn(DATASETS, dataset) ? DATASETS[dataset] : null;
  if (!def) notFound();
  const format = formatParam.parse(new URL(req.url).searchParams.get("format") ?? undefined);
  const enc = new TextEncoder();
  let after: unknown[] | null = null;
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started && format === "csv") {
          started = true;
          controller.enqueue(enc.encode(`﻿${csvLine(def.columns)}`));
          return;
        }
        started = true;
        const rows = await def.page(after, BATCH);
        if (!rows.length) { controller.close(); return; }
        after = def.key(rows[rows.length - 1]);
        const text = format === "csv"
          ? rows.map((r) => csvLine(def.columns.map((c) => iso(r[c])))).join("")
          : rows.map((r) => `${JSON.stringify(Object.fromEntries(def.columns.map((c) => [c, iso(r[c]) ?? null])))}\n`).join("");
        controller.enqueue(enc.encode(text));
      } catch (e) {
        console.error(`export ${dataset} failed:`, (e as Error).message);
        controller.error(e);
      }
    },
  });
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  return new Response(body, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="tabayyun-${dataset}-${day}.${format}"`,
      "Cache-Control": "no-store",
    },
  });
}
