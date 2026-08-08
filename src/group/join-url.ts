/**
 * 参加用の URL。
 *
 * 接続コードは 300 文字を超える base64 で、紙から手で打つのは現実的ではない。
 * URL にしておけば、紙に印刷した QR を読むだけでアプリが開き、入力済みの状態で
 * 始められる。読み取りは端末のカメラアプリでもアプリ内のスキャナでもよい。
 *
 * ひとりぶんの情報 (接続コード・メールアドレス・最初のパスワード) をまとめて
 * 載せた QR は、**1回読むだけでログインが済む**。そのぶん紙そのものが鍵に
 * なるので、印刷物には「配ったら本人以外に見せない」ことを書く。
 */

export interface JoinCredentials {
  email: string
  password: string
}

export interface JoinLink {
  code: string
  email?: string
  password?: string
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
  } catch {
    return null
  }
}

export function buildJoinUrl(
  connectionCode: string,
  appBaseUrl: string,
  credentials?: JoinCredentials,
): string {
  const base = appBaseUrl.endsWith('/') ? appBaseUrl : `${appBaseUrl}/`
  if (!credentials) {
    return `${base}#/login?c=${encodeURIComponent(connectionCode)}`
  }
  // 1つのパラメータにまとめる。3つに分けると、1つだけ欠けた URL が回りやすい
  const packed = toBase64Url(
    JSON.stringify({ c: connectionCode, e: credentials.email, p: credentials.password }),
  )
  return `${base}#/login?j=${packed}`
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

/**
 * QR やリンクが運んできたものを読む。
 *
 * まとめた形 (`j`) と、接続コードだけの形 (`c`) の両方を受ける。古い紙が
 * 出回っていても読めなくならないようにするため。欠けている項目は埋めない。
 */
export function parseJoinLink(query: Record<string, unknown>): JoinLink | null {
  const packed = query.j
  if (typeof packed === 'string' && packed.trim() !== '') {
    const decoded = fromBase64Url(packed.trim())
    if (decoded === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(decoded)
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object') return null
    const fields = parsed as { c?: unknown; e?: unknown; p?: unknown }
    if (typeof fields.c !== 'string' || fields.c === '') return null
    return {
      code: fields.c,
      ...(typeof fields.e === 'string' ? { email: fields.e } : {}),
      ...(typeof fields.p === 'string' ? { password: fields.p } : {}),
    }
  }

  const code = connectionCodeFromQuery(query.c)
  return code === '' ? null : { code }
}

/** QR から読み取った文字列が、このアプリの参加リンクなら中身を返す。 */
export function parseJoinText(text: string): JoinLink | null {
  const trimmed = text.trim()
  let hash: string
  try {
    hash = new URL(trimmed).hash
  } catch {
    // URL でないなら、接続コードそのものが書かれていることもある
    return trimmed === '' ? null : { code: trimmed }
  }
  const at = hash.indexOf('?')
  if (at === -1) return null
  const params = new URLSearchParams(hash.slice(at + 1))
  return parseJoinLink(Object.fromEntries(params.entries()))
}
