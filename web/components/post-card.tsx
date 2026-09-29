import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { formatDate, formatTime, langAttrs, picked, type Locale, type UrduDigits } from "@/lib/urdu";
import { getSitePrefs } from "@/lib/queries";
import { RelativeTime } from "./relative-time";

/** What a post card shows. Never the post's media: images from posts are not shown (D10). */
export type PostCardPost = {
  platform: string;
  authorHandle: string;
  authorName: string;
  text: string;
  url: string;
  postedAt: Date;
  isRepost?: boolean;
  inReplyTo?: string | null;
  lang?: string | null;
};

const PLATFORMS = ["x", "bluesky", "telegram", "youtube"] as const;
type Platform = (typeof PLATFORMS)[number];
const platformOf = (p: string): Platform => ((PLATFORMS as readonly string[]).includes(p) ? (p as Platform) : "x");

/**
 * A post quoted verbatim, with its platform, author, time and a link to the original; never paraphrased,
 * never with its images. Only the post text takes the post's language; the byline stays in the page's.
 * On a story page (the posts the story cites) and on the X board (D10), where it can also say which of the
 * latest edition's names it mentions (`matched`) and link to the story that cites it (`cited`). A reply
 * or a bare repost is shown quieter and labelled as such.
 */
export async function PostCard({ post, locale, digits, cited, matched = [], board = false }: {
  post: PostCardPost; locale: Locale; digits?: UrduDigits;
  cited?: { id: number; titleEn: string; titleUr: string } | null; matched?: { en: string; ur: string }[]; board?: boolean;
}) {
  const t = await getTranslations();
  const d = digits ?? (locale === "ur" ? (await getSitePrefs()).digitsUr : undefined);
  const isUrdu = /[؀-ۿ]/.test(post.text);
  const textLang: Locale = isUrdu ? "ur" : "en";
  const other = !isUrdu && post.lang && !/^(en|ur)\b/i.test(post.lang) ? post.lang.slice(0, 12) : null;
  const platform = platformOf(post.platform);
  const platformName = t(`board.platform.${platform}`);
  const reply = !!post.inReplyTo, repost = !!post.isRepost;
  const quiet = board && (reply || repost);
  const iso = post.postedAt.toISOString();
  const citedTitle = cited ? picked(cited, "title", locale) : null;
  return (
    <article className={`card p-4 ${quiet ? "post-quiet" : ""}`}>
      <header className="ui flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 text-[length:var(--step--1)] font-semibold text-ink-2"><PlatformIcon platform={platform} /><span>{platformName}</span></span>
        <bdi className="font-semibold text-ink">{post.authorName || post.authorHandle}</bdi>
        <span className="meta latin" dir="ltr">@{post.authorHandle}</span>
        {reply && <span className="pill pill-soft">{t("board.reply")}</span>}
        {repost && <span className="pill pill-soft">{t("board.repost")}</span>}
      </header>
      <blockquote className="m-0 mt-2" cite={post.url}>
        <p className={`whitespace-pre-line ${quiet ? "text-ink-2" : ""}`} {...(other ? { lang: other, dir: "auto" as const } : { ...langAttrs(textLang, locale), dir: "auto" as const })}>{post.text}</p>
      </blockquote>
      {matched.length > 0 && (
        <p className="meta mt-2">{t("board.about")}{" "}
          {matched.map((m, i) => {
            // The name in the page's language when the edition has it (an Urdu page shows the Urdu name).
            const name = locale === "ur" && m.ur ? m.ur : m.en || m.ur;
            return <span key={`${m.en}|${m.ur}`}>{i > 0 ? " · " : ""}<bdi {...langAttrs(/[؀-ۿ]/.test(name) ? "ur" : "en", locale)}>{name}</bdi></span>;
          })}
        </p>
      )}
      {cited && citedTitle && (
        <p className="ui mt-2">
          {t.rich("board.citedIn", { s: (c) => <Link href={`/story/${cited.id}`} className="font-semibold" {...langAttrs(citedTitle.lang, locale)}>{c}</Link>, title: citedTitle.text })}
        </p>
      )}
      <footer className="meta mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{formatDate(post.postedAt, locale, { dateStyle: "medium" }, d)} · {formatTime(post.postedAt, locale, d)}<RelativeTime iso={iso} locale={locale} digits={d} absolute={false} prefix=" · " /></span>
        <a href={post.url} target="_blank" rel="noopener noreferrer nofollow" className="ms-auto">
          {board ? t("board.viewOn", { platform: platformName }) : t("story.asPosted")} <span aria-hidden="true">{locale === "ur" ? "↖" : "↗"}</span>
        </a>
      </footer>
    </article>
  );
}

/** A small mark per platform (decorative: the name is always written beside it). */
function PlatformIcon({ platform }: { platform: Platform }) {
  const common = { "aria-hidden": true, viewBox: "0 0 24 24", width: "0.95em", height: "0.95em", className: "shrink-0" } as const;
  if (platform === "bluesky") return <svg {...common} fill="currentColor"><path d="M12 11.3C10.9 9.2 8 5.3 5.4 3.4 2.9 1.6 2 1.9 1.4 2.2.7 2.5.6 3.6.6 4.3c0 .6.4 5.3.6 6.1.8 2.6 3.6 3.5 6.2 3.2-3.8.6-7.1 2-2.7 6.9 4.8 5 6.6-1.1 7.5-4.1.9 3 2 8.8 7.4 4.1 4.1-4.1 1.1-6.2-2.6-6.8 2.6.3 5.4-.6 6.2-3.2.2-.8.6-5.5.6-6.1 0-.7-.1-1.8-.8-2.1-.6-.3-1.5-.6-4 1.2C16 5.3 13.1 9.2 12 11.3z" /></svg>;
  if (platform === "youtube") return <svg {...common} fill="currentColor"><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12 31 31 0 0 0 1 16.8a3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1c.4-1.6.5-3.2.5-4.8s-.1-3.2-.5-4.8zM9.8 15V9l5.8 3-5.8 3z" /></svg>;
  if (platform === "telegram") return <svg {...common} fill="currentColor"><path d="M21.9 4.3 18.6 19.8c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.3-8.4c.4-.4-.1-.6-.6-.2L6 13.3 1 11.8c-1.1-.3-1.1-1.1.2-1.6l19.4-7.5c.9-.3 1.7.2 1.3 1.6z" /></svg>;
  return <svg {...common} fill="currentColor"><path d="M17.8 2.5h3.3l-7.2 8.2 8.5 11.3h-6.6l-5.2-6.8-6 6.8H1.3l7.7-8.8L.9 2.5h6.8l4.7 6.2 5.4-6.2zm-1.2 17.5h1.8L6.6 4.4H4.6L16.6 20z" /></svg>;
}
