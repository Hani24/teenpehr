import { withdrawStoryAction } from "@/lib/admin/review-actions";
import { WITHDRAW_NOTE_MAX } from "@/lib/codes";
import { Button, Checkbox, Field, Textarea } from "./form";

/**
 * "Withdraw story…" (decision D14): a disclosure, the reason in English and/or Urdu, and a confirm box, so it
 * takes a deliberate second step. Used on the Review page and on a published edition's page.
 */
export function WithdrawForm({ storyId, back, owner }: { storyId: number; back: string; owner: boolean }) {
  return (
    <details className="min-w-0 basis-full sm:basis-auto">
      <summary className="chip inline-flex cursor-pointer font-semibold !text-accent">Withdraw story…</summary>
      <form action={withdrawStoryAction} className="mt-2 grid max-w-3xl gap-2 rounded border border-accent p-3 sm:grid-cols-2">
        <input type="hidden" name="story_id" value={storyId} /><input type="hidden" name="back" value={back} />
        <p className="text-sm sm:col-span-2">
          Readers stop seeing this story in its edition, the feeds, search, downloads and the X board. Its address then shows only
          &ldquo;This story was withdrawn by the editors&rdquo;, the date and your reason, never its text. {owner ? "You (an owner)" : "An owner"} can undo this.
        </p>
        <Field label="Reason for readers (English)"><Textarea name="note_en" maxLength={WITHDRAW_NOTE_MAX} className="!min-h-16" /></Field>
        <Field label="Reason for readers (Urdu)"><Textarea name="note_ur" maxLength={WITHDRAW_NOTE_MAX} lang="ur" dir="rtl" className="!min-h-16" /></Field>
        <p className="meta sm:col-span-2">A reason in English or Urdu is required (both is best: readers see the one in their language).</p>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Checkbox name="confirm" label="I have read the story and want to withdraw it from readers" required />
          <Button tone="danger" className="!border-accent !text-accent">Withdraw from readers</Button>
        </div>
      </form>
    </details>
  );
}
