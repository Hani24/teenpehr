"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AuthError, createInvite, destroyAllSessions, emailSchema, InviteError, revokeInvite, ROLES, setUserRole, setUserStatus } from "@/lib/auth";
import { requireOwner } from "@/lib/admin/session";
import { num, str, withFlash } from "@/lib/admin/util";
import { formatDate } from "@/lib/urdu";

/*
 * Owner-only account management (decision D2). Every action checks the owner role itself (Server
 * Actions are public endpoints; Next also refuses cross-site posts to them). An owner cannot change
 * their own role or switch themselves off here, and the last active owner can never be demoted or
 * disabled (setUserRole/setUserStatus refuse with AuthError "last_owner").
 */
const BACK = "/admin/users";

export type LinkState =
  | { ok: true; kind: "invite" | "reset"; email: string; url: string; until: string; message: string }
  | { ok: false; error: string }
  | null;

/** The text an owner sends with a link (WhatsApp or anywhere), in the language the link opens in. */
function linkMessage(kind: "invite" | "reset", locale: "en" | "ur", url: string, until: string): string {
  if (locale === "ur") {
    return kind === "invite"
      ? `آپ کو تبیُّن پڑھنے کی دعوت ہے، جو اردو اور انگریزی میں خبروں کی روزانہ اشاعت ہے۔ اپنا اکاؤنٹ بنانے کے لیے یہ لنک کھولیں۔ یہ صرف ایک بار، ${until} تک کام کرے گا:\n${url}`
      : `تبیُّن پر نیا پاس ورڈ بنانے کا لنک۔ یہ صرف ایک بار، ${until} تک کام کرے گا:\n${url}`;
  }
  return kind === "invite"
    ? `You're invited to read Tabayyun, a daily news digest in English and Urdu. Open this link to create your account. It works once, until ${until}:\n${url}`
    : `Your Tabayyun password reset link. It works once, until ${until}:\n${url}`;
}

function linkState(kind: "invite" | "reset", email: string, locale: "en" | "ur", made: { url: string; expiresAt: Date }): LinkState {
  const until = formatDate(made.expiresAt, locale, { dateStyle: "medium", timeStyle: "short", hourCycle: locale === "ur" ? "h23" : "h12" });
  return { ok: true, kind, email, url: made.url, until, message: linkMessage(kind, locale, made.url, until) };
}

const inviteSchema = z.object({ email: emailSchema, role: z.enum(ROLES), locale: z.enum(["en", "ur"]) });

export async function inviteUser(_prev: LinkState, fd: FormData): Promise<LinkState> {
  const owner = await requireOwner();
  const parsed = inviteSchema.safeParse({ email: str(fd, "email"), role: str(fd, "role") || "reader", locale: str(fd, "locale") || "en" });
  if (!parsed.success) return { ok: false, error: "Enter a valid email address, role and language." };
  const { email, role, locale } = parsed.data;
  try {
    const made = await createInvite({ email, role, kind: "invite", createdBy: owner.id, locale });
    revalidatePath(BACK);
    return linkState("invite", email, locale, made);
  } catch (e) {
    if (e instanceof InviteError && e.code === "user_exists") return { ok: false, error: `${email} already has an account. Use its reset link instead.` };
    throw e;
  }
}

const idSchema = z.coerce.number().int().positive();

export async function resetLink(_prev: LinkState, fd: FormData): Promise<LinkState> {
  const owner = await requireOwner();
  const id = idSchema.safeParse(str(fd, "id"));
  const locale = str(fd, "locale") === "ur" ? "ur" : "en";
  if (!id.success) return { ok: false, error: "Unknown account." };
  const [u] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, id.data));
  if (!u) return { ok: false, error: "Unknown account." };
  try {
    const made = await createInvite({ email: u.email, kind: "reset", createdBy: owner.id, locale });
    revalidatePath(BACK);
    return linkState("reset", u.email, locale, made);
  } catch (e) {
    if (e instanceof InviteError) return { ok: false, error: e.code === "disabled" ? "That account is switched off: enable it first." : "Unknown account." };
    throw e;
  }
}

/** The account a row form names, or a flash error when it is the owner's own (they would lock themselves out). */
async function otherUser(fd: FormData, what: string): Promise<{ ownerId: number; id: number }> {
  const owner = await requireOwner();
  const id = num(fd, "id");
  if (!id || !Number.isInteger(id)) redirect(await withFlash(BACK, { error: "Unknown account." }));
  if (id === owner.id) redirect(await withFlash(BACK, { error: `You cannot ${what} your own account here. Ask another owner.` }));
  return { ownerId: owner.id, id };
}

async function refused(e: unknown): Promise<never> {
  if (e instanceof AuthError) {
    redirect(await withFlash(BACK, { error: e.code === "last_owner" ? "Not changed: that is the last active owner. Make someone else an owner first." : "Unknown account." }));
  }
  throw e;
}

export async function changeRole(fd: FormData): Promise<void> {
  const { id } = await otherUser(fd, "change the role of");
  const role = z.enum(ROLES).safeParse(str(fd, "role"));
  if (!role.success) redirect(await withFlash(BACK, { error: "Unknown role." }));
  try { await setUserRole(id, role.data); } catch (e) { await refused(e); }
  revalidatePath(BACK);
  redirect(await withFlash(BACK, { ok: `Role changed to ${role.data}.` }));
}

export async function changeStatus(fd: FormData): Promise<void> {
  const { id } = await otherUser(fd, "switch off");
  const status = z.enum(["active", "disabled"]).safeParse(str(fd, "status"));
  if (!status.success) redirect(await withFlash(BACK, { error: "Unknown status." }));
  try { await setUserStatus(id, status.data); } catch (e) { await refused(e); }
  revalidatePath(BACK);
  redirect(await withFlash(BACK, { ok: status.data === "disabled" ? "Account switched off and signed out everywhere; its feed link and the links it made no longer work. Its saved items stay." : "Account switched on again." }));
}

export async function revokeSessions(fd: FormData): Promise<void> {
  const owner = await requireOwner();
  const id = num(fd, "id");
  if (!id || !Number.isInteger(id)) redirect(await withFlash(BACK, { error: "Unknown account." }));
  // Your own: every other device, not the one you are using. The feed link and any open reset link go too.
  const n = await destroyAllSessions(id, { exceptCurrent: id === owner.id });
  revalidatePath(BACK);
  redirect(await withFlash(BACK, { ok: `${n ? `Signed out ${n} session${n === 1 ? "" : "s"}` : "No sessions to sign out"}. Its private feed link and any open reset link no longer work.` }));
}

export async function revokeLink(fd: FormData): Promise<void> {
  await requireOwner();
  const id = num(fd, "id");
  if (!id || !Number.isInteger(id)) redirect(await withFlash(BACK, { error: "Unknown link." }));
  await revokeInvite(id);
  revalidatePath(BACK);
  redirect(await withFlash(BACK, { ok: "Link revoked: it no longer works." }));
}
