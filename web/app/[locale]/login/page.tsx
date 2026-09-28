import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth";
import { isAuthPage, safeNextPath } from "@/lib/auth/paths";
import { isLocale, type Locale } from "@/lib/urdu";
import { LOGIN_EMAIL_COOKIE } from "@/app/api/auth/_lib";
import { AuthPanel, Notice, SubmitButton, TextField } from "@/components/auth-ui";
import { PasswordInput } from "@/components/password-input";

export async function generateMetadata({ params }: PageProps<"/[locale]/login">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("signInTitle"), robots: { index: false, follow: false } };
}

const ERRORS = ["invalid", "rate_limited", "disabled", "bad_request", "bad_link"] as const;
const OKS = ["signed_out", "signed_out_all"] as const;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Sign in (decision D2). A plain form posting to /api/auth/login; the page only shows its result codes. */
export default async function LoginPage({ params, searchParams }: PageProps<"/[locale]/login">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const l = locale as Locale;
  const sp = await searchParams;
  const back = safeNextPath(one(sp.next), "");
  const next = isAuthPage(back.split("?")[0]) ? "" : back;
  if (await getCurrentUser()) redirect(next || `/${l}`);

  const t = await getTranslations("auth");
  const error = ERRORS.find((e) => e === one(sp.error));
  const ok = OKS.find((o) => o === one(sp.ok));
  const email = (await cookies()).get(LOGIN_EMAIL_COOKIE)?.value ?? "";
  return (
    <AuthPanel title={t("signInTitle")} lead={<p>{t("signInLead")}</p>}>
      {error ? <Notice tone="error">{t(`errors.${error}`)}</Notice>
        : ok ? <Notice tone="ok">{t(`ok.${ok}`)}</Notice>
        : next ? <Notice tone="info">{t("continue")}</Notice> : null}
      <form method="post" action="/api/auth/login" className="card p-5 sm:p-6">
        <input type="hidden" name="locale" value={l} />
        {next && <input type="hidden" name="next" value={next} />}
        <TextField id="email" name="email" type="email" label={t("email")} defaultValue={email} required autoFocus={!email}
          autoComplete="username" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} dir="auto" maxLength={320} />
        <PasswordInput name="password" label={t("password")} showLabel={t("showPassword")}
          autoComplete="current-password" required autoFocus={!!email} maxLength={1000} />
        <SubmitButton>{t("submit")}</SubmitButton>
      </form>
      <p className="measure mt-6 text-ink-2">{t("forgot")}</p>
      <p className="measure mt-2 text-ink-2">{t("noAccount")}</p>
    </AuthPanel>
  );
}
