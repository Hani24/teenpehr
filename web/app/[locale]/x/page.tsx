import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/lib/auth";
import { BOARD_HOURS, BOARD_MAX_PAGES, BOARD_PAGE_SIZE, getBoard, getBoardOverview, type BoardOverview, type BoardPage } from "@/lib/board";
import { getGroups, getSitePrefs } from "@/lib/queries";
import { formatDate, isLocale, localDigits, slotNames, type Locale, type Slot } from "@/lib/urdu";
import { alternatesFor, dateAt } from "@/lib/view";
import { PostCard } from "@/components/post-card";

// The site's chip target size and pressed look (as in components/save-button.tsx). Written out here, not
// imported: save-button.tsx is a client module, and a constant imported from one into a server component
// is a client reference (a function), not the string, so the classes would never reach the page.
const TARGET = "!min-h-11 wazeh:!min-h-[max(48px,2.4em)] wazeh:!min-w-12";
const PRESSED = "!border-rule-strong !bg-ink !text-paper";

/*
 * The X board (decision D10): recent posts from the watched handles, in section tabs, most relevant to the
 * latest published edition first (lib/board.ts ranks in SQL). Posts are quoted verbatim with a link to the
 * original, never paraphrased and never with their images. Paged with plain links ("More posts"), no
 * infinite scroll (Wazeh). Behind the login wall like every reader page; not kept offline (public/sw.js).
 */

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const querySchema = z.object({
  group: z.string().regex(/^[a-z0-9-]{1,60}$/).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(BOARD_MAX_PAGES).optional().catch(undefined),
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "board" });
  return { title: t("title"), alternates: alternatesFor("/x", locale), robots: { index: false, follow: false } };
}

/** /x with a group and a page (both left out when default). */
function boardHref(group: string | undefined, page = 1): string {
  const qs = new URLSearchParams();
  if (group) qs.set("group", group);
  if (page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return `/x${s ? `?${s}` : ""}`;
}

export default async function BoardPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const l = locale as Locale;
  const raw = await searchParams;
  const q = querySchema.parse({ group: typeof raw.group === "string" ? raw.group : undefined, page: typeof raw.page === "string" ? raw.page : undefined });
  await requireUser({ locale: l, next: `/${l}${boardHref(q.group, q.page ?? 1)}` });
  const [t, prefs, groups] = await Promise.all([getTranslations({ locale: l, namespace: "board" }), getSitePrefs(), getGroups()]);
  const digits = l === "ur" ? prefs.digitsUr : undefined;
  const num = (s: string) => localDigits(s, l, digits);
  const group = q.group ? groups.find((g) => g.slug === q.group) : undefined;
  const unknownGroup = !!q.group && !group;
  const page = q.page ?? 1;
  const name = (g: (typeof groups)[number]) => (l === "ur" ? g.nameUr : g.nameEn);

  let board: BoardPage | null = null;
  let overview: BoardOverview | null = null;
  try {
    [board, overview] = await Promise.all([getBoard(group?.id ?? null, page), getBoardOverview()]);
  } catch (e) {
    console.error("x board failed:", (e as Error).message);
  }

  const inTab = overview ? (group ? overview.byGroup[group.id] ?? 0 : overview.total) : 0;
  const pages = Math.min(BOARD_MAX_PAGES, Math.max(1, Math.ceil(inTab / BOARD_PAGE_SIZE)));
  const basis = board?.basis ?? overview?.basis ?? null;
  const editionName = (b: { date: string; slot: Slot }) => `${formatDate(dateAt(b.date), l, { dateStyle: "long" }, digits)} · ${slotNames[b.slot][l]}`;
  // Why a tab is empty: no approved X List for the section (or for any), and whether Bluesky accounts are watched there.
  const listsMissing = overview ? (group ? !overview.xListGroups.includes(group.id) : overview.xListGroups.length === 0) : false;
  const blueskyWatched = overview ? (group ? (overview.handlesByGroup[group.id]?.bluesky ?? 0) : overview.handles.bluesky) : 0;

  return (
    <div className="mx-auto max-w-3xl px-[var(--gutter)] pb-16">
      <h1 className="display rule-strong mt-4 pt-4 text-[length:var(--step-3)]">{t("title")}</h1>
      <p className="mt-2 measure text-ink-2">{t("intro")}</p>
      <p className="meta mt-2 measure">{t("verbatim")}</p>

      <nav aria-label={t("sections")} className="mt-5">
        <ul className="ui flex flex-wrap gap-2">
          <li>
            <Link href={boardHref(undefined)} prefetch={false} aria-current={!group ? "page" : undefined} className={`chip ${TARGET} ${!group ? PRESSED : ""}`}>
              {t("all")}{overview ? <span className="num">{num(` (${overview.total})`)}</span> : null}
            </Link>
          </li>
          {groups.map((g) => (
            <li key={g.id}>
              <Link href={boardHref(g.slug)} prefetch={false} aria-current={group?.id === g.id ? "page" : undefined} className={`chip ${TARGET} ${group?.id === g.id ? PRESSED : ""}`}>
                {name(g)}{overview ? <span className="num">{num(` (${overview.byGroup[g.id] ?? 0})`)}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {unknownGroup && <p role="status" className="card mt-4 p-3 text-ink-2">{t("unknownSection")}</p>}

      {!board || !overview ? (
        <p role="alert" className="card mt-6 p-4 text-warn">{t("error")}</p>
      ) : (
        <section className="mt-6" aria-labelledby="board-h">
          <h2 id="board-h" className="ui rule-strong pt-2 text-[length:var(--step-1)] font-bold">
            {group ? name(group) : t("all")}: {num(t("window", { count: inTab, hours: BOARD_HOURS }))}
          </h2>
          <p className="meta mt-2">
            {basis ? t.rich("basis", { edition: editionName(basis), e: (c) => <Link href={`/${basis.date}/${basis.slot}`}>{c}</Link> }) : t("noBasis")}
          </p>

          {board.posts.length === 0 ? (
            <div className="card mt-4 p-4">
              <p className="font-semibold">{page > 1 ? t("pastEnd") : t("emptyTitle")}</p>
              {page > 1 ? (
                <p className="mt-2"><Link href={boardHref(group?.slug)}>{t("firstPage")}</Link></p>
              ) : (
                <>
                  <p className="mt-2 measure">{num(group ? t("emptySection", { hours: BOARD_HOURS }) : t("emptyAll", { hours: BOARD_HOURS }))}</p>
                  {listsMissing
                    ? <p className="mt-2 measure">{blueskyWatched > 0 ? t("listsPending") : t("listsPendingNoBluesky")}</p>
                    : <p className="mt-2 measure">{t("collectorQuiet")}</p>}
                </>
              )}
            </div>
          ) : (
            <>
              {listsMissing && page === 1 && <p className="meta mt-3 measure">{t("listsPendingShort")}</p>}
              <ol className="mt-4 grid list-none gap-3 p-0" aria-label={t("postsLabel")}>
                {board.posts.map((p) => (
                  <li key={p.id}>
                    <PostCard board locale={l} digits={digits} matched={p.matched} cited={p.cited}
                      post={{ platform: p.platform, authorHandle: p.authorHandle, authorName: p.authorName, text: p.text, url: p.url, postedAt: new Date(p.postedAt), isRepost: p.isRepost, inReplyTo: p.isReply ? "reply" : null, lang: p.lang }} />
                  </li>
                ))}
              </ol>
              {pages > 1 && (
                <nav aria-label={t("pages")} className="ui mt-6 flex flex-wrap items-center gap-3">
                  {page > 1 && <Link href={boardHref(group?.slug, page - 1)} prefetch={false} rel="prev" className={`chip ${TARGET}`}>{t("previous")}</Link>}
                  <span className="meta">{num(t("page", { page, pages }))}</span>
                  {page < pages && <Link href={boardHref(group?.slug, page + 1)} prefetch={false} rel="next" className={`chip ${TARGET} font-semibold text-ink`}>{t("more")}</Link>}
                </nav>
              )}
            </>
          )}
          <p className="meta mt-8 measure">
            {num(t("watched", { x: overview.handles.x, bluesky: overview.handles.bluesky }))} <Link href="/about#hnd">{t("watchedLink")}</Link>
          </p>
        </section>
      )}
    </div>
  );
}
