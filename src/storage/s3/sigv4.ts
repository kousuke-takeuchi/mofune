import type { Bytes } from '../../crypto/bytes'
import { toHex, utf8 } from '../../crypto/bytes'
import { sha256 } from '../../crypto/symmetric'

export const ALGORITHM = 'AWS4-HMAC-SHA256'
export const SERVICE = 's3'
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
}

export interface CanonicalRequestInput {
  method: string
  /** 生のパス。この関数がエンコードするので、呼び出し側でエンコードしない。 */
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  payloadHash: string
}

export interface SignRequestOptions {
  credentials: S3Credentials
  region: string
  method: string
  url: URL
  headers?: Record<string, string>
  payload?: Bytes
  now?: Date
}

/**
 * RFC 3986 の unreserved 文字以外を %XX にする。encodeURIComponent は
 * "!" "'" "(" ")" "*" を通してしまい AWS の規則と一致しないため自前で実装する。
 */
export function uriEncode(text: string, encodeSlash: boolean): string {
  let out = ''
  for (const ch of text) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch
      continue
    }
    if (ch === '/' && !encodeSlash) {
      out += ch
      continue
    }
    for (const byte of utf8(ch)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

export function canonicalQueryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name, true)}=${uriEncode(query[name] as string, true)}`)
    .join('&')
}

export function canonicalHeaders(headers: Record<string, string>): {
  canonical: string
  signed: string
} {
  const lower: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    lower[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ')
  }
  const names = Object.keys(lower).sort()
  return {
    canonical: names.map((name) => `${name}:${lower[name] as string}\n`).join(''),
    signed: names.join(';'),
  }
}

export function canonicalRequest(input: CanonicalRequestInput): string {
  const headers = canonicalHeaders(input.headers)
  return [
    input.method.toUpperCase(),
    uriEncode(input.path, false),
    canonicalQueryString(input.query),
    headers.canonical,
    headers.signed,
    input.payloadHash,
  ].join('\n')
}

/** ISO 8601 基本形式 (20260807T091234Z) と日付だけの形式 (20260807) を返す。 */
export function amzTimestamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

export function credentialScope(dateStamp: string, region: string): string {
  return `${dateStamp}/${region}/${SERVICE}/aws4_request`
}

async function hmac(key: Bytes, data: string): Promise<Bytes> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, utf8(data)))
}

export async function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
): Promise<Bytes> {
  const dateKey = await hmac(utf8(`AWS4${secretAccessKey}`), dateStamp)
  const regionKey = await hmac(dateKey, region)
  const serviceKey = await hmac(regionKey, SERVICE)
  return hmac(serviceKey, 'aws4_request')
}

export async function stringToSign(
  amzDate: string,
  scope: string,
  request: string,
): Promise<string> {
  return [ALGORITHM, amzDate, scope, toHex(await sha256(utf8(request)))].join('\n')
}

export async function calculateSignature(key: Bytes, toSign: string): Promise<string> {
  return toHex(await hmac(key, toSign))
}

/** Authorization ヘッダ方式で署名し、リクエストに付けるヘッダ一式を返す。 */
export async function signRequestHeaders(
  options: SignRequestOptions,
): Promise<Record<string, string>> {
  const { amzDate, dateStamp } = amzTimestamps(options.now ?? new Date())
  const scope = credentialScope(dateStamp, options.region)
  const payloadHash = toHex(await sha256(options.payload ?? new Uint8Array(0)))

  const headers: Record<string, string> = {
    ...options.headers,
    host: options.url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }

  const query: Record<string, string> = {}
  options.url.searchParams.forEach((value, name) => {
    query[name] = value
  })

  const request = canonicalRequest({
    method: options.method,
    path: options.url.pathname,
    query,
    headers,
    payloadHash,
  })
  const key = await signingKey(options.credentials.secretAccessKey, dateStamp, options.region)
  const signature = await calculateSignature(key, await stringToSign(amzDate, scope, request))
  const signedHeaders = canonicalHeaders(headers).signed

  return {
    ...headers,
    Authorization:
      `${ALGORITHM} Credential=${options.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
