import { getTranslations } from "next-intl/server";
import { formatDate, formatTime, type Locale } from "@/lib/urdu";
import type { StoryFull } from "@/lib/queries";

export async function PostCard({ post, locale }: { post: StoryFull["posts"][number]["post"]; locale: Locale }) {
  const t = await getTranslations("story");
  const isUrdu = /[؀-ۿ]/.test(post.text);
  return (
    <blockquote className="card p-4" lang={isUrdu ? "ur" : "en"} dir={isUrdu ? "rtl" : "ltr"}>
      <p className="whitespace-pre-line">{post.text}</p>
      <footer className="meta mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="latin font-semibold text-ink">{post.authorName || post.authorHandle}</span>
        <span className="latin">@{post.authorHandle}</span>
        <span>{formatDate(post.postedAt, locale, { dateStyle: "medium" })} · {formatTime(post.postedAt, locale)}</span>
        <a href={post.url} target="_blank" rel="noopener noreferrer" className="ms-auto">{t("asPosted")} ↗</a>
      </footer>
    </blockquote>
  );
}
