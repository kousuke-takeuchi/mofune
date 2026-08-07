import type { Bytes } from './bytes'

export class Base32Error extends Error {}

/**
 * Crockford Base32。I / L / O / U を含まないので、手書きの転記で
 * 0 と O、1 と I を取り違える事故が起きにくい。
 */
export const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function toBase32(bytes: Bytes): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  }
  return out
}

/** 人は必ず間違えるので、紛らわしい字は受け入れて読み替える。 */
function symbolValue(ch: string): number {
  const upper = ch.toUpperCase()
  if (upper === 'O') return 0
  if (upper === 'I' || upper === 'L') return 1
  const index = BASE32_ALPHABET.indexOf(upper)
  if (index < 0) {
    throw new Base32Error(`"${ch}" is not a base32 symbol`)
  }
  return index
}

export function fromBase32(text: string): Bytes {
  const cleaned = text.replace(/[-\s]/g, '')
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of cleaned) {
    buffer = (buffer << 5) | symbolValue(ch)
    bits += 5
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** 印刷して目で追えるよう、区切りと改行を入れる。 */
export function groupForPrinting(text: string, groupSize = 4, perLine = 8): string {
  if (text.length === 0) return ''
  const groups: string[] = []
  for (let i = 0; i < text.length; i += groupSize) {
    groups.push(text.slice(i, i + groupSize))
  }
  const lines: string[] = []
  for (let i = 0; i < groups.length; i += perLine) {
    lines.push(groups.slice(i, i + perLine).join('-'))
  }
  return lines.join('\n')
}
