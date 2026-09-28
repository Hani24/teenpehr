import { Link } from "@/i18n/navigation";
import { isTopic, topicLabel } from "@/lib/taxonomy";
import type { Locale } from "@/lib/urdu";

/** A story's topics as links to their topic pages. Unknown slugs (from a newer build) are left out. */
export function TopicChips({ topics, locale, label, max }: { topics: readonly string[]; locale: Locale; label: string; max?: number }) {
  const shown = topics.filter(isTopic).slice(0, max);
  if (!shown.length) return null;
  return (
    <ul className="ui inline-flex flex-wrap items-center gap-1.5" aria-label={label}>
      {shown.map((t) => (
        // No prefetch: a topic page is per-reader (behind the login) and a list of cards would prefetch dozens.
        <li key={t}><Link href={`/topic/${t}`} prefetch={false} className="chip">{topicLabel(t, locale)}</Link></li>
      ))}
    </ul>
  );
}
