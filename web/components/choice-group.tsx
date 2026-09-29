import type { Locale } from "@/lib/urdu";

export type Choice = { value: string; label: string; lang?: Locale };

/**
 * A radio group drawn as chips (decision D7): the search filters, instead of a pull-down <select>. Each
 * chip holds a real radio input (transparent, covering the chip; app/globals.css .choice), so it works
 * without script inside a plain GET form, keeps the group's arrow keys and announces itself as a radio.
 * The checked chip is inverted and shows a tick, so the state never rests on colour alone. `value` is
 * the current choice; "" is the group's "any" option, which should come first.
 */
export function ChoiceGroup({ name, legend, choices, value, pageLocale }: { name: string; legend: string; choices: Choice[]; value?: string; pageLocale: Locale }) {
  const current = value ?? "";
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className="meta mb-2">{legend}</legend>
      <div className="choices ui">
        {choices.map((c) => (
          <label key={c.value || "_any"} className="choice" lang={c.lang && c.lang !== pageLocale ? c.lang : undefined} dir={c.lang && c.lang !== pageLocale ? (c.lang === "ur" ? "rtl" : "ltr") : undefined}>
            <input type="radio" name={name} value={c.value} defaultChecked={c.value === current} />
            <span aria-hidden="true" className="choice-tick">✓</span>
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
