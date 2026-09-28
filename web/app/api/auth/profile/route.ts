import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { getCurrentUser, invalidateUserCache } from "@/lib/auth";
import { normalizeUrdu } from "@/lib/urdu";
import { field, localeOf, methodNotAllowed, readForm, sameOrigin, seeOther } from "../_lib";

/* POST /api/auth/profile (form: name, locale). The signed-in reader's display name (shown to owners). */
const form = z.object({ name: z.string().trim().max(100) });

export async function POST(req: NextRequest) {
  const fd = await readForm(req);
  const locale = localeOf(fd);
  const back = (params: Record<string, string>) => seeOther(`/${locale}/account`, params, "#profile");
  const user = await getCurrentUser();
  if (!user) return seeOther(`/${locale}/login`, { next: `/${locale}/account` });
  if (!fd || !sameOrigin(req)) return back({ error: "bad_request" });
  const parsed = form.safeParse({ name: normalizeUrdu(field(fd, "name")) });
  if (!parsed.success) return back({ error: "name_too_long" });
  await db.update(schema.users).set({ name: parsed.data.name }).where(eq(schema.users.id, user.id));
  invalidateUserCache(user.id);
  return back({ ok: "profile" });
}

export const GET = methodNotAllowed;
