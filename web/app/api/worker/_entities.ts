import "server-only";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { schema } from "@/db";
import type { EntityIn } from "@/lib/contracts";
import { normalizeUrdu } from "@/lib/urdu";
import type { Tx } from "./_shared";

const { entities } = schema;
const MAX_ALIASES = 20;

/** URL slug of an entity name: ASCII, lower case, hyphens; a name with no Latin letters gets a hash. */
export function entitySlug(nameEn: string): string {
  const base = nameEn.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  return base || `e-${createHash("sha1").update(nameEn.toLowerCase()).digest("hex").slice(0, 10)}`;
}

/** An entity is one (kind, slug of name_en): "Punjab" the place and "Punjab" the team are two rows. */
export const entityKey = (e: Pick<EntityIn, "kind" | "name_en">) => `${e.kind}:${entitySlug(e.name_en)}`;

/**
 * The URL slugs an entity may have, in order: the name's slug, then `<slug>-<kind>`, then numbered ones
 * (`<slug>-<kind>-2` …) for the rare case where another kind holds both (an organisation named
 * "X Person"), and a hashed one last, so a free slug is always found.
 */
function slugCandidates(base: string, kind: EntityIn["kind"]): string[] {
  const numbered = Array.from({ length: 8 }, (_, i) => `${base}-${kind}-${i + 2}`);
  return [base, `${base}-${kind}`, ...numbered, `${base}-${kind}-${createHash("sha1").update(`${kind}:${base}`).digest("hex").slice(0, 8)}`];
}

/**
 * Upsert the payload's entities (docs/API.md § PUT …/editions) and return entityKey → id. The URL slug is
 * the first free one of slugCandidates(); a row of the same kind on any of them is this entity. An empty
 * Urdu name is filled, a stored one is never overwritten, and another English spelling of the same slug
 * is kept as an alias (for search). Mention counts move at publish time (lib/insights.ts syncEntityStats).
 */
export async function upsertEntities(tx: Tx, list: EntityIn[]): Promise<Map<string, number>> {
  const wanted = new Map<string, { kind: EntityIn["kind"]; base: string; nameEn: string; nameUr: string; spellings: Set<string> }>();
  for (const e of list) {
    const key = entityKey(e), nameUr = normalizeUrdu(e.name_ur ?? "").trim();
    const w = wanted.get(key);
    if (w) { w.spellings.add(e.name_en); if (!w.nameUr) w.nameUr = nameUr; continue; }
    wanted.set(key, { kind: e.kind, base: entitySlug(e.name_en), nameEn: e.name_en, nameUr, spellings: new Set([e.name_en]) });
  }
  const ids = new Map<string, number>();
  if (!wanted.size) return ids;
  const cols = { id: entities.id, kind: entities.kind, slug: entities.slug, nameEn: entities.nameEn, nameUr: entities.nameUr, aliases: entities.aliases };
  const candidates = [...wanted.values()].flatMap((w) => slugCandidates(w.base, w.kind));
  const rows = await tx.select(cols).from(entities).where(inArray(entities.slug, [...new Set(candidates)]));
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  for (const [key, w] of wanted) {
    const found = slugCandidates(w.base, w.kind).map((slug) => bySlug.get(slug)).find((r) => r?.kind === w.kind);
    if (found) {
      const aliases = [...found.aliases];
      for (const s of w.spellings) if (s !== found.nameEn && !aliases.includes(s) && aliases.length < MAX_ALIASES) aliases.push(s);
      const fillUr = !found.nameUr && !!w.nameUr;
      if (fillUr || aliases.length !== found.aliases.length) {
        await tx.update(entities).set({ ...(fillUr ? { nameUr: w.nameUr } : {}), aliases }).where(eq(entities.id, found.id));
      }
      ids.set(key, found.id);
      continue;
    }
    const aliases = [...w.spellings].filter((s) => s !== w.nameEn).slice(0, MAX_ALIASES);
    let id: number | null = null;
    for (const slug of slugCandidates(w.base, w.kind)) {
      if (bySlug.has(slug)) continue; // another kind's (a same-kind row was found above)
      let [row] = await tx.insert(entities).values({ kind: w.kind, slug, nameEn: w.nameEn, nameUr: w.nameUr, aliases, mentionCount: 0 })
        .onConflictDoNothing({ target: entities.slug }).returning(cols);
      // Another request inserted this slug between our read and our insert: its row, if it is this kind.
      if (!row) [row] = await tx.select(cols).from(entities).where(eq(entities.slug, slug));
      if (!row) continue;
      bySlug.set(slug, row);
      if (row.kind === w.kind) { id = row.id; break; }
    }
    if (id === null) throw new Error(`no free slug for entity ${w.kind} "${w.nameEn}"`);
    ids.set(key, id);
  }
  return ids;
}
