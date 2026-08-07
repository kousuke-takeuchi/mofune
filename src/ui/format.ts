/**
 * 画面に出す日時。ISO のまま出すと機械の文字列に見えて読めない。
 * 今年なら「8/7 20:56」、去年以前は「2025/8/7」まで出す。
 */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso

  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const date = `${at.getMonth() + 1}/${at.getDate()}`
  if (at.getFullYear() !== now.getFullYear()) {
    return `${at.getFullYear()}/${date}`
  }
  return `${date} ${time}`
}
