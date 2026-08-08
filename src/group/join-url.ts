/**
 * 参加用の URL。
 *
 * 接続コードは 300 文字を超える base64 で、紙から手で打つのは現実的ではない。
 * URL にしておけば、紙に印刷した QR を端末のカメラで読むだけでアプリが開き、
 * コードが入った状態になる。アプリ側に読み取り機能を持たせなくて済む。
 */
export function buildJoinUrl(connectionCode: string, appBaseUrl: string): string {
  const base = appBaseUrl.endsWith('/') ? appBaseUrl : `${appBaseUrl}/`
  return `${base}#/login?c=${encodeURIComponent(connectionCode)}`
}

/** いま動いているアプリの配信元。開発中でも本番でも同じ形の URL になる。 */
export function currentAppBaseUrl(): string {
  const { origin, pathname } = window.location
  // /app/ 配下で配信している。ハッシュより前の部分だけを起点にする。
  return `${origin}${pathname}`
}

/** ルータのクエリから接続コードを取り出す。読めない形なら空を返す。 */
export function connectionCodeFromQuery(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
