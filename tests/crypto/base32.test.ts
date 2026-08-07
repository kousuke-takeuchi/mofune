import { describe, it, expect } from 'vitest'
import { BASE32_ALPHABET, Base32Error, fromBase32, groupForPrinting, toBase32 } from '../../src/crypto/base32'
import { utf8, fromUtf8, toHex } from '../../src/crypto/bytes'

describe('BASE32_ALPHABET', () => {
  it('has 32 symbols', () => {
    expect(BASE32_ALPHABET).toHaveLength(32)
  })

  it('leaves out the letters people confuse with digits', () => {
    for (const letter of ['I', 'L', 'O', 'U']) {
      expect(BASE32_ALPHABET).not.toContain(letter)
    }
  })
})

describe('toBase32 / fromBase32', () => {
  it('round-trips an empty input', () => {
    expect(fromBase32(toBase32(new Uint8Array(0)))).toEqual(new Uint8Array(0))
  })

  it('round-trips a short input', () => {
    const input = utf8('mofune')
    expect(fromUtf8(fromBase32(toBase32(input)))).toBe('mofune')
  })

  it('round-trips arbitrary bytes at every length up to 40', () => {
    for (let length = 0; length <= 40; length += 1) {
      const input = new Uint8Array(length)
      for (let i = 0; i < length; i += 1) input[i] = (i * 37 + 11) % 256
      expect(toHex(fromBase32(toBase32(input)))).toBe(toHex(input))
    }
  })

  it('produces only alphabet symbols', () => {
    const input = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    for (const ch of toBase32(input)) {
      expect(BASE32_ALPHABET).toContain(ch)
    }
  })

  it('reads lower case back', () => {
    const input = utf8('mofune')
    expect(fromUtf8(fromBase32(toBase32(input).toLowerCase()))).toBe('mofune')
  })

  it('forgives the letters people mistype', () => {
    const encoded = toBase32(utf8('mofune'))
    const mistyped = encoded.replace(/0/g, 'O').replace(/1/g, 'I')
    expect(toHex(fromBase32(mistyped))).toBe(toHex(fromBase32(encoded)))
  })

  it('ignores hyphens and whitespace', () => {
    const encoded = toBase32(utf8('mofune'))
    const spaced = groupForPrinting(encoded)
    expect(toHex(fromBase32(spaced))).toBe(toHex(fromBase32(encoded)))
  })

  it('rejects a symbol outside the alphabet', () => {
    expect(() => fromBase32('ABC$')).toThrow(Base32Error)
  })
})

describe('groupForPrinting', () => {
  it('inserts a hyphen every four characters', () => {
    expect(groupForPrinting('ABCDEFGH', 4, 100)).toBe('ABCD-EFGH')
  })

  it('breaks lines after the requested number of groups', () => {
    expect(groupForPrinting('ABCDEFGHIJKL', 4, 2)).toBe('ABCD-EFGH\nIJKL')
  })

  it('does not leave a trailing separator', () => {
    const printed = groupForPrinting('ABCDEF', 4, 100)
    expect(printed.endsWith('-')).toBe(false)
    expect(printed).toBe('ABCD-EF')
  })

  it('returns an empty string unchanged', () => {
    expect(groupForPrinting('')).toBe('')
  })
})
