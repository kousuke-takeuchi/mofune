/**
 * Service Worker が持ってよいものの判定。
 *
 * 持つのは「アプリの殻」だけ。保管場所のデータは持たない。持つと端末に中身が
 * 増えるうえ、古いものを配ってしまう。お知らせの控えは IndexedDB が持っている。
 */
export function belongsToShell(url: string, appBase: string): boolean {
  let target: URL
  let base: URL
  try {
    target = new URL(url)
    base = new URL(appBase)
  } catch {
    return false
  }
  if (target.origin !== base.origin) return false

  // 同梱フォントは紹介サイトと共用なので、アプリの外に置いてある
  if (target.pathname.startsWith('/fonts/')) return true

  return target.pathname.startsWith(base.pathname)
}
