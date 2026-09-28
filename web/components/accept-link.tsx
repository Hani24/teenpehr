import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { checkInvite, getCurrentUser, type InviteKind } from "@/lib/auth";
import { getSitePrefs } from "@/lib/queries";
import { formatDate, type Locale } from "@/lib/urdu";
import { AuthPanel, Notice, SubmitButton, TextField } from "./auth-ui";
import { PasswordInput } from "./password-input";

/*
 * The page behind an invite link (/{locale}/invite/{token}: name and password, creates the account) or
 * a reset link (/{locale}/reset/{token}: a new password). Checking the link changes nothing; the form
 * posts to /api/auth/accept, which consumes it and signs in. A dead link says why, in plain words.
 */
const LINK_ERRORS = ["invalid", "used", "expired", "user_exists", "disabled"] as const;
const PROBLEMS = ["too_short", "too_long", "common", "same_as_email", "mismatch"] as const;

export async function AcceptLink({ kind, token, locale, error }: { kind: InviteKind; token: string; locale: Locale; error: string }) {
  const t = await getTranslations("auth");
  const title = kind === "invite" ? t("inviteTitle") : t("resetTitle");
  const check = await checkInvite(token);
  const linkError = !check.ok ? check.reason : check.invite.kind !== kind ? "invalid" : LINK_ERRORS.find((e) => e === error);
  if (linkError) {
    return (
      <AuthPanel title={title}>
        <Notice tone="error">{t(`link.${linkError}`)}</Notice>
        <p><Link href="/login" className="chip">{t("goToSignIn")}</Link></p>
      </AuthPanel>
    );
  }
  if (!check.ok) return null; // narrowed above; keeps TypeScript's view of `check` simple
  const { invite } = check;
  const [current, prefs] = await Promise.all([getCurrentUser(), getSitePrefs()]);
  const problem = PROBLEMS.find((p) => p === error);
  const formError = problem ? t(`problem.${problem}`) : error === "bad_request" ? t("errors.bad_request") : "";
  const until = formatDate(invite.expiresAt, locale, { dateStyle: "long", timeStyle: "short", hourCycle: locale === "ur" ? "h23" : "h12" }, prefs.digitsUr);
  return (
    <AuthPanel title={title} lead={<p>{kind === "invite" ? t("inviteLead", { role: invite.role }) : t("resetLead")}</p>}>
      {formError && <Notice tone="error">{formError}</Notice>}
      {current && current.email !== invite.email && (
        <Notice tone="info">
          {/* Isolated, and free to break anywhere (!: the unlayered :lang(ur) rule sets overflow-wrap: normal). */}
          {t.rich("switchAccount", { email: current.email, addr: (c) => <bdi dir="ltr" className="latin wrap-anywhere!">{c}</bdi> })}
        </Notice>
      )}
      <form method="post" action="/api/auth/accept" className="card p-5 sm:p-6">
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="locale" value={locale} />
        {/* The email is fixed by the link; shown so password managers save it with the new password. */}
        <TextField id="email" name="email" type="email" label={t("accountEmail")} value={invite.email} readOnly autoComplete="username" dir="ltr" />
        {kind === "invite" && (
          <TextField id="name" name="name" label={t("name")} hint={t("nameHint")} autoComplete="name" dir="auto" maxLength={100} />
        )}
        <PasswordInput name="password" label={t("newPassword")} hint={t("passwordHint")} showLabel={t("showPassword")}
          autoComplete="new-password" required minLength={10} maxLength={200} autoFocus={kind === "reset"} />
        <PasswordInput name="confirm" label={t("confirmPassword")} showLabel={t("showPassword")}
          autoComplete="new-password" required minLength={10} maxLength={200} />
        <SubmitButton>{kind === "invite" ? t("createAccount") : t("savePassword")}</SubmitButton>
        <p className="meta mt-4">{t("expiresOn", { date: until })}</p>
      </form>
    </AuthPanel>
  );
}
