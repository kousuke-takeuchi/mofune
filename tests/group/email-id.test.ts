import { describe, it, expect } from 'vitest'
import { EmailError, normalizeEmail } from '../../src/group/email-id'

describe('normalizeEmail', () => {
  it('keeps a plain address as it is', () => {
    expect(normalizeEmail('sato@example.com')).toBe('sato@example.com')
  })

  it('ignores the case people happen to type', () => {
    // キーストアの置き場所はこの文字列から決まる。大小が揺れると入れなくなる。
    expect(normalizeEmail('Sato@Example.COM')).toBe('sato@example.com')
  })

  it('ignores the spaces a mail client wraps in', () => {
    expect(normalizeEmail('  sato@example.com \n')).toBe('sato@example.com')
  })

  it('refuses something that is not an address', () => {
    for (const bad of ['', '   ', 'sato', 'sato@', '@example.com', 'sato example.com']) {
      expect(() => normalizeEmail(bad)).toThrow(EmailError)
    }
  })
})
