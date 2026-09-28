/**
 * Story topics and event types: the fixed vocabulary curation tags stories with (stories.topics,
 * stories.event_type) and the edition PUT validates (lib/contracts.ts). Slugs are stored, so never
 * rename one; add a new slug instead. Safe for client components.
 */
export const TOPICS = [
  "politics", "economy", "security", "diplomacy", "courts-law", "elections", "religion", "society", "human-rights", "health",
  "education", "climate-environment", "disaster", "energy", "technology", "business", "culture", "sport", "migration", "conflict",
] as const;
export type Topic = (typeof TOPICS)[number];

export const EVENT_TYPES = [
  "statement", "election", "protest", "attack", "court-ruling", "economic-data",
  "diplomatic-visit", "agreement", "disaster", "appointment", "legislation", "other",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

type Label = { en: string; ur: string };

export const TOPIC_LABELS: Record<Topic, Label> = {
  politics: { en: "Politics", ur: "سیاست" },
  economy: { en: "Economy", ur: "معیشت" },
  security: { en: "Security", ur: "سلامتی" },
  diplomacy: { en: "Diplomacy", ur: "سفارت کاری" },
  "courts-law": { en: "Courts and law", ur: "عدالت و قانون" },
  elections: { en: "Elections", ur: "انتخابات" },
  religion: { en: "Religion", ur: "مذہب" },
  society: { en: "Society", ur: "معاشرہ" },
  "human-rights": { en: "Human rights", ur: "انسانی حقوق" },
  health: { en: "Health", ur: "صحت" },
  education: { en: "Education", ur: "تعلیم" },
  "climate-environment": { en: "Climate and environment", ur: "موسم اور ماحول" },
  disaster: { en: "Disasters", ur: "آفات" },
  energy: { en: "Energy", ur: "توانائی" },
  technology: { en: "Technology", ur: "ٹیکنالوجی" },
  business: { en: "Business", ur: "کاروبار" },
  culture: { en: "Culture", ur: "ثقافت" },
  sport: { en: "Sport", ur: "کھیل" },
  migration: { en: "Migration", ur: "نقل مکانی" },
  conflict: { en: "Conflict", ur: "جنگ و تنازع" },
};

export const EVENT_TYPE_LABELS: Record<EventType, Label> = {
  statement: { en: "Statement", ur: "بیان" },
  election: { en: "Election", ur: "انتخاب" },
  protest: { en: "Protest", ur: "احتجاج" },
  attack: { en: "Attack", ur: "حملہ" },
  "court-ruling": { en: "Court ruling", ur: "عدالتی فیصلہ" },
  "economic-data": { en: "Economic data", ur: "معاشی اعداد و شمار" },
  "diplomatic-visit": { en: "Diplomatic visit", ur: "سفارتی دورہ" },
  agreement: { en: "Agreement", ur: "معاہدہ" },
  disaster: { en: "Disaster", ur: "آفت" },
  appointment: { en: "Appointment", ur: "تقرری" },
  legislation: { en: "Legislation", ur: "قانون سازی" },
  other: { en: "Other", ur: "دیگر" },
};

export function isTopic(x: unknown): x is Topic {
  return typeof x === "string" && (TOPICS as readonly string[]).includes(x);
}
export function isEventType(x: unknown): x is EventType {
  return typeof x === "string" && (EVENT_TYPES as readonly string[]).includes(x);
}

/** The label for a stored slug; an unknown slug (from a newer build) shows as itself. */
export function topicLabel(slug: string, locale: "en" | "ur"): string {
  return isTopic(slug) ? TOPIC_LABELS[slug][locale] : slug;
}
export function eventTypeLabel(slug: string, locale: "en" | "ur"): string {
  return isEventType(slug) ? EVENT_TYPE_LABELS[slug][locale] : slug;
}
