import { getTranslations } from "next-intl/server";
import { formatDate, formatTime, langAttrs, type Locale } from "@/lib/urdu";
import { getSitePrefs, type StoryFull } from "@/lib/queries";

/** A post quoted verbatim. Only the post text takes the post's language; the byline stays in the page's. */
export async function PostCard({ post, locale }: { post: StoryFull["posts"][number]["post"]; locale: Locale }) {
  const t = await getTranslations("story");
  const digits = locale === "ur" ? (await getSitePrefs()).digitsUr : undefined;
  const isUrdu = /[؀-ۿ]/.test(post.text);
  return (
    <blockquote className="card p-4">
      <p className="whitespace-pre-line" {...langAttrs(isUrdu ? "ur" : "en", locale)}>{post.text}</p>
      <footer className="meta mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <bdi className="font-semibold text-ink">{post.authorName || post.authorHandle}</bdi>
        <span className="latin">@{post.authorHandle}</span>
        <span>{formatDate(post.postedAt, locale, { dateStyle: "medium" }, digits)} · {formatTime(post.postedAt, locale, digits)}</span>
        <a href={post.url} target="_blank" rel="noopener noreferrer" className="ms-auto">{t("asPosted")} <span aria-hidden="true">{locale === "ur" ? "↖" : "↗"}</span></a>
      </footer>
    </blockquote>
  );
}
