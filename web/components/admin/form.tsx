const base = "w-full rounded border border-rule bg-surface px-2 py-1.5 text-sm text-ink focus:border-focus";

export function Field({ label, children, hint, className = "" }: { label: string; children: React.ReactNode; hint?: string; className?: string }) {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="mb-1 block font-semibold">{label}</span>
      {children}
      {hint && <span className="meta mt-1 block">{hint}</span>}
    </label>
  );
}
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${base} ${props.className ?? ""}`} />;
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${base} min-h-24 ${props.className ?? ""}`} />;
}
export function Select({ options, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { options: Array<[string, string]> }) {
  return (
    <select {...props} className={`${base} ${props.className ?? ""}`}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}
export function Checkbox({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <input type="checkbox" {...props} className="h-4 w-4" />
      <span>{label}</span>
    </label>
  );
}
export function Button({ children, tone = "default", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "primary" | "danger" }) {
  const cls = tone === "primary" ? "bg-ink text-paper border-ink" : tone === "danger" ? "border-accent text-accent" : "";
  return <button type="submit" {...props} className={`chip cursor-pointer font-semibold ${cls} ${props.className ?? ""}`}>{children}</button>;
}
