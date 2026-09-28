import Link from "next/link";

/**
 * 403 for a signed-in account without the role an admin page needs (requireAdmin/requireOwner in
 * lib/admin/session.ts call forbidden()). The admin has no locale, so it says it in both languages.
 */
export default function AdminForbidden() {
  return (
    <main className="mx-auto mt-24 max-w-lg p-6">
      <p className="masthead-title text-3xl">Tabayyun</p>
      <h1 className="headline mt-4 text-2xl">This page is for the newsroom</h1>
      <p className="mt-2 text-ink-2">Your account can read the site but not use the admin. If you should have access, ask the site&apos;s owner.</p>
      <div lang="ur" dir="rtl" className="mt-6 border-t border-rule pt-4">
        <p className="text-xl font-semibold">یہ صفحہ نیوز روم کے لیے ہے</p>
        <p className="mt-1 text-ink-2">آپ کا اکاؤنٹ سائٹ پڑھ سکتا ہے، انتظامی صفحات نہیں۔ اگر آپ کو رسائی ملنی چاہیے تو سائٹ کے مالک سے بات کریں۔</p>
      </div>
      <p className="mt-8 flex flex-wrap gap-2">
        <Link href="/en" className="chip font-semibold">Back to the site</Link>
        <Link href="/ur" className="chip font-semibold" lang="ur" dir="rtl">سائٹ پر واپس جائیں</Link>
      </p>
    </main>
  );
}
