/**
 * ArrayBuffer に固定した Uint8Array。TypeScript 5.7 以降 Uint8Array は
 * ArrayBufferLike 既定になり、WebCrypto の BufferSource に代入できないため、
 * バイト列は一貫してこの別名を使う。
 */
export type Bytes = Uint8Array<ArrayBuffer>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function utf8(text: string): Bytes {
  return encoder.encode(text)
}

export function fromUtf8(bytes: Bytes): string {
  return decoder.decode(bytes)
}

export function toBase64(bytes: Bytes): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number)
  }
  return btoa(binary)
}

export function fromBase64(text: string): Bytes {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

export function toBase64Url(bytes: Bytes): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Bytes {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4))
}

export function toHex(bytes: Bytes): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, '0')
  }
  return out
}

export function concat(...parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** 長さが異なる場合は即座に false。同じ長さなら定数時間で比較する。 */
export function equal(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number)
  }
  return diff === 0
}
