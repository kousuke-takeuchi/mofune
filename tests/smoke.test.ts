import { describe, it, expect } from 'vitest'

describe('toolchain', () => {
  it('exposes Web Crypto with SHA-256 in the test environment', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3]))
    expect(new Uint8Array(digest)).toHaveLength(32)
  })

  it('exposes crypto.getRandomValues', () => {
    const buf = new Uint8Array(16)
    crypto.getRandomValues(buf)
    expect(buf.some((byte) => byte !== 0)).toBe(true)
  })
})
