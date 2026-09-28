/**
 * Account roles, safe to import from client components (labels, menus). reader < editor < owner:
 * readers read the site, editors also run the admin and newsroom, owners also manage accounts.
 */
export const ROLES = ["reader", "editor", "owner"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(x: unknown): x is Role {
  return typeof x === "string" && (ROLES as readonly string[]).includes(x);
}

/** True when `role` has at least the rights of `min`. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(min);
}
