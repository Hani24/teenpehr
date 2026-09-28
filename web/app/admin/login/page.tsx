import { redirect } from "next/navigation";
import { getCurrentUser, loginPath } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The old admin sign-in address. Accounts sign in on the site's page, then come back to /admin. */
export default async function AdminLoginPage() {
  if (await getCurrentUser()) redirect("/admin");
  redirect(loginPath("en", "/admin"));
}
