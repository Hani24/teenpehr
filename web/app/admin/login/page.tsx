import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/admin/session";
import { login } from "@/lib/admin/actions";
import { ActionForm } from "@/components/admin/action-form";
import { Field, Input } from "@/components/admin/form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await isAdmin()) redirect("/admin");
  return (
    <main className="mx-auto mt-24 max-w-sm p-6">
      <p className="masthead-title text-3xl">Teen Pehr</p>
      <h1 className="meta mb-6">Admin sign in</h1>
      <ActionForm action={login} submitLabel="Sign in" className="card p-4">
        <Field label="Password"><Input type="password" name="password" autoComplete="current-password" required autoFocus /></Field>
      </ActionForm>
    </main>
  );
}
