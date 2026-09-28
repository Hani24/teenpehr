/**
 * Print an invite (or password reset) link. There is no sign-up, so this is how the first owner gets
 * in; after that, owners invite people from the admin.
 *
 *   npm run user:invite -- --email you@example.com --role owner
 *   npm run user:invite -- --email you@example.com --kind reset     (a new password for an existing account)
 *   options: --role reader|editor|owner (default reader), --locale en|ur (default en)
 *
 * The link is built from SITE_URL (web/.env.local) and is the only copy of the token: send it privately.
 * Runs with the react-server condition (see package.json) so the server-only modules load outside Next.
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { db } from "@/db";
import { createInvite, InviteError } from "@/lib/auth/invites";
import { ROLES } from "@/lib/auth/roles";
import { emailSchema } from "@/lib/auth/users";

const args = z.object({
  email: emailSchema,
  role: z.enum(ROLES).default("reader"),
  kind: z.enum(["invite", "reset"]).default("invite"),
  locale: z.enum(["en", "ur"]).default("en"),
});

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string" }, role: { type: "string" }, kind: { type: "string" }, locale: { type: "string" } } });
  const parsed = args.safeParse(values);
  if (!parsed.success) {
    console.error(`usage: npm run user:invite -- --email a@b.c [--role reader|editor|owner] [--kind invite|reset] [--locale en|ur]\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
    return 2;
  }
  const { email, role, kind, locale } = parsed.data;
  if (!process.env.SITE_URL) console.error("SITE_URL is not set; the link points at http://localhost:3000");
  try {
    const { url, expiresAt } = await createInvite({ email, role, kind, locale, createdBy: null });
    console.log(`${kind === "reset" ? "Password reset" : `Invite (${role})`} for ${email}, single use, expires ${expiresAt.toISOString()}:`);
    console.log(url);
    return 0;
  } catch (e) {
    if (e instanceof InviteError) {
      const why = { user_exists: "that email already has an account (use --kind reset)", no_user: "no account has that email", disabled: "that account is disabled" }[e.code];
      console.error(`Not created: ${why}.`);
      return 1;
    }
    throw e;
  }
}

main().then(async (code) => { await db.$client.end(); process.exit(code); }, async (e) => { console.error(e); await db.$client.end(); process.exit(1); });
