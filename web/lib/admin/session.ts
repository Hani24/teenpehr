import "server-only";
import { forbidden } from "next/navigation";
import { getCurrentUser, requireUser, roleAtLeast, type Role, type SessionUser } from "@/lib/auth";

/*
 * Admin access on top of the accounts in lib/auth (decision D2; the shared ADMIN_PASSWORD is retired).
 * requireAdmin() keeps the name every admin page and action already calls: signed out it sends to the
 * sign-in page (then back to /admin), and a signed-in reader gets a 403 (forbidden(), rendered by
 * app/admin/forbidden.tsx). The proxy already answers readers on admin addresses with its own plain 403
 * page; this is the check that holds if a request ever reaches a page or action without it.
 */

async function requireAdminRole(min: Role, next: string): Promise<SessionUser> {
  const user = await requireUser({ locale: "en", next });
  if (!roleAtLeast(user.role, min)) forbidden();
  return user;
}

/** Call first in every admin page and action: editors and owners pass. */
export async function requireAdmin(next = "/admin"): Promise<SessionUser> {
  return requireAdminRole("editor", next);
}

/** Owner-only admin (accounts). Editors get the 403 page. */
export async function requireOwner(next = "/admin/users"): Promise<SessionUser> {
  return requireAdminRole("owner", next);
}

export async function isAdmin(): Promise<boolean> {
  const user = await getCurrentUser();
  return !!user && roleAtLeast(user.role, "editor");
}
