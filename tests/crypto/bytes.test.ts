import { describe, it, expect } from 'vitest'
import {
  utf8,
  fromUtf8,
  toBase64,
  fromBase64,
  toBase64Url,
  fromBase64Url,
  toHex,
  concat,
  equal,
} from '../../src/crypto/bytes'

describe('bytes', () => {
  it('round-trips UTF-8 including multibyte characters', () => {
    expect(fromUtf8(utf8('ひらがな漢字'))).toBe('ひらがな漢字')
  })

  it('round-trips base64 for arbitrary bytes', () => {
    const input = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255])
    expect(fromBase64(toBase64(input))).toEqual(input)
  })

  it('produces base64url without padding or unsafe characters', () => {
    const input = new Uint8Array([251, 255, 190, 255])
    const encoded = toBase64Url(input)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(fromBase64Url(encoded)).toEqual(input)
  })

  it('formats hex with zero padding', () => {
    expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe('000f10ff')
  })

  it('concatenates parts in order', () => {
    expect(concat(new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3]))).toEqual(
      new Uint8Array([1, 2, 3]),
    )
  })

  it('compares byte arrays by content', () => {
    expect(equal(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(equal(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(equal(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })
})
