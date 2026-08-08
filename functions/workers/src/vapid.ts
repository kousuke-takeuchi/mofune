/**
 * VAPID (RFC 8292) の署名。push サービスは「この push は本当にこの鍵の持ち主が
 * 出したのか」をここで確かめる。中身の暗号化 (RFC 8291) は無内容 push なので要らない。
 */

export interface VapidKeys {
  /** base64url の生の公開鍵 (65バイトの非圧縮点)。 */
  publicKey: string
  /** base64url の PKCS#8 秘密鍵。 */
  privateKey: string
}

/** 署名の有効期限。RFC 8292 の上限は24時間だが、長く持たせる理由が無い。 */
const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60

/** 端末が電源を切っていても、あとで届くように1日は預かってもらう。 */
const PUSH_TTL_SECONDS = 24 * 60 * 60

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function encodeJson(value: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)))
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  return {
    publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
  }
}

/**
 * 署名する相手は push サービスの**オリジン**であって、購読ごとの URL ではない。
 * ここを endpoint そのままにすると、どのサービスも 401 を返す。
 */
export function vapidAudience(endpoint: string): string {
  return new URL(endpoint).origin
}

export async function buildVapidHeaders(options: {
  endpoint: string
  /** 連絡先。push サービスが問題を見つけたときに使う。 */
  subject: string
  keys: VapidKeys
  now?: Date
}): Promise<Record<string, string>> {
  const issuedAt = Math.floor((options.now?.getTime() ?? Date.now()) / 1000)
  const header = encodeJson({ typ: 'JWT', alg: 'ES256' })
  const payload = encodeJson({
    aud: vapidAudience(options.endpoint),
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
    sub: options.subject,
  })

  const key = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64Url(options.keys.privateKey) as unknown as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  )

  return {
    Authorization: `vapid t=${header}.${payload}.${toBase64Url(signature)}, k=${options.keys.publicKey}`,
    TTL: String(PUSH_TTL_SECONDS),
    // 無内容 push。ここを省くと中身つきと見なす push サービスがある
    'Content-Length': '0',
  }
}
