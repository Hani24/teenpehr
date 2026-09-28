import type { Metadata } from "next";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema } from "@/db";
import { ROLES } from "@/lib/auth";
import { requireOwner } from "@/lib/admin/session";
import { ago, fmtDate } from "@/lib/admin/util";
import { AdminShell } from "@/components/admin/shell";
import { Button, Select } from "@/components/admin/form";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { flashFrom } from "@/components/admin/flash";
import { Empty, Table, Td, Th } from "@/components/admin/table";
import { changeRole, changeStatus, inviteUser, resetLink, revokeLink, revokeSessions } from "./actions";
import { LinkForm } from "./link-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Users" };

const roleOptions = ROLES.map((r) => [r, r] as [string, string]);
const localeOptions: Array<[string, string]> = [["en", "English page"], ["ur", "Urdu page"]];

/** Owner-only: accounts, invites and reset links (decision D2). */
export default async function UsersPage({ searchParams }: PageProps<"/admin/users">) {
  const me = await requireOwner();
  const flash = await flashFrom(searchParams);
  const { users, sessions, invites } = schema;
  const creator = alias(users, "creator");
  const [rows, open] = await Promise.all([
    db.select({
      id: users.id, email: users.email, name: users.name, role: users.role, status: users.status,
      lastLoginAt: users.lastLoginAt, lastVisitAt: users.lastVisitAt, createdAt: users.createdAt,
      // Qualified by hand: inside the subquery an unqualified "id" would be sessions.id.
      sessions: sql<number>`(select count(*)::int from ${sessions} s where s.user_id = ${users}.id and s.expires_at > now())`,
      feedOn: sql<boolean>`${users.feedTokenHash} is not null`,
    }).from(users).orderBy(asc(users.createdAt)),
    db.select({ id: invites.id, email: invites.email, role: invites.role, kind: invites.kind, createdAt: invites.createdAt, expiresAt: invites.expiresAt, by: creator.email })
      .from(invites).leftJoin(creator, eq(creator.id, invites.createdBy))
      .where(and(isNull(invites.usedAt), gt(invites.expiresAt, new Date()))).orderBy(desc(invites.createdAt)),
  ]);
  const owners = rows.filter((r) => r.role === "owner" && r.status === "active").length;

  return (
    <AdminShell title="Users" flash={flash}>
      <section aria-labelledby="invite-h" className="card mb-6 p-4">
        <h2 id="invite-h" className="font-semibold">Invite someone</h2>
        <p className="meta mb-3">There is no sign-up. The link creates one account for this email, works once and expires in 7 days. Send it privately.</p>
        <LinkForm action={inviteUser} submitLabel="Create invite link">
          <label className="block text-sm">
            <span className="mb-1 block font-semibold">Email</span>
            <input type="email" name="email" required autoComplete="off" dir="auto" className="min-h-10 w-72 max-w-full rounded border border-rule bg-surface px-2 py-1.5 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold">Role</span>
            <Select name="role" defaultValue="reader" options={roleOptions} className="min-h-10" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-semibold">Link opens</span>
            <Select name="locale" defaultValue="en" options={localeOptions} className="min-h-10" />
          </label>
        </LinkForm>
        <p className="meta mt-3">Readers read the site; editors also run this admin; owners also manage accounts.</p>
      </section>

      <h2 className="mb-2 font-semibold">Accounts ({rows.length})</h2>
      {rows.length === 0 ? <Empty>No accounts yet.</Empty> : (
        <Table caption="Accounts">
          <thead>
            <tr><Th>Account</Th><Th>Role</Th><Th>Status</Th><Th>Last sign-in</Th><Th>Sessions</Th><Th>Reset link</Th></tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const self = u.id === me.id;
              const lastOwner = u.role === "owner" && u.status === "active" && owners <= 1;
              return (
                <tr key={u.id}>
                  <Td>
                    <p className="font-semibold"><bdi>{u.name || "—"}</bdi>{self && <span className="pill pill-soft ms-2">you</span>}</p>
                    <p className="meta"><bdi>{u.email}</bdi></p>
                    <p className="meta">joined {fmtDate(u.createdAt)}</p>
                  </Td>
                  <Td>
                    {self ? <span>{u.role}</span> : (
                      <form action={changeRole} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="id" value={u.id} />
                        <Select name="role" defaultValue={u.role} options={roleOptions} aria-label={`Role of ${u.email}`} className="w-28" disabled={lastOwner} />
                        {!lastOwner && <Button>Save</Button>}
                      </form>
                    )}
                    {lastOwner && <p className="meta mt-1">last active owner</p>}
                  </Td>
                  <Td>
                    <span className={`pill ${u.status === "active" ? "pill-soft text-ok" : "pill-accent"}`}>{u.status === "active" ? "active" : "switched off"}</span>
                    {!self && !lastOwner && (
                      <form action={changeStatus} className="mt-2">
                        <input type="hidden" name="id" value={u.id} />
                        <input type="hidden" name="status" value={u.status === "active" ? "disabled" : "active"} />
                        {u.status === "active"
                          ? <ConfirmButton confirmLabel="Confirm: switch off">Switch off</ConfirmButton>
                          : <Button>Switch on</Button>}
                      </form>
                    )}
                  </Td>
                  <Td>
                    <p>{u.lastLoginAt ? ago(u.lastLoginAt) : "never"}</p>
                    <p className="meta">seen {u.lastVisitAt ? ago(u.lastVisitAt) : "—"}</p>
                  </Td>
                  <Td>
                    <p>{u.sessions}</p>
                    {u.feedOn && <p className="meta">feed link on</p>}
                    {(u.sessions > 0 || u.feedOn) && (
                      <form action={revokeSessions} className="mt-1">
                        <input type="hidden" name="id" value={u.id} />
                        <ConfirmButton confirmLabel="Confirm: sign out">{self ? "Sign out other devices" : "Sign out everywhere"}</ConfirmButton>
                      </form>
                    )}
                  </Td>
                  <Td>
                    {u.status === "active" ? (
                      <LinkForm action={resetLink} submitLabel="Make reset link" className="max-w-md">
                        <input type="hidden" name="id" value={u.id} />
                        <Select name="locale" defaultValue="en" options={localeOptions} aria-label="Reset page language" className="min-h-10 w-36" />
                      </LinkForm>
                    ) : <span className="meta">switch on first</span>}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <h2 className="mb-2 mt-8 font-semibold">Open links ({open.length})</h2>
      {open.length === 0 ? <Empty>No unused invite or reset links.</Empty> : (
        <Table caption="Open links">
          <thead><tr><Th>Email</Th><Th>Kind</Th><Th>Role</Th><Th>Made</Th><Th>Expires</Th><Th /></tr></thead>
          <tbody>
            {open.map((i) => (
              <tr key={i.id}>
                <Td><bdi>{i.email}</bdi></Td>
                <Td>{i.kind}</Td>
                <Td>{i.kind === "invite" ? i.role : "—"}</Td>
                <Td>{fmtDate(i.createdAt)}<p className="meta">{i.by ? <>by <bdi>{i.by}</bdi></> : "from the command line"}</p></Td>
                <Td>{fmtDate(i.expiresAt)}</Td>
                <Td>
                  <form action={revokeLink}>
                    <input type="hidden" name="id" value={i.id} />
                    <ConfirmButton confirmLabel="Confirm: revoke">Revoke</ConfirmButton>
                  </form>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="meta mt-4">Links are stored only as a hash, so an open link cannot be shown again: revoke it and make a new one.</p>
    </AdminShell>
  );
}
