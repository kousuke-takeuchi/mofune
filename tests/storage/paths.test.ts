import { describe, it, expect } from 'vitest'
import {
  manifestPath,
  rosterPath,
  keyringPath,
  keystorePath,
  messagePath,
  filePath,
  eventPath,
  inboxPath,
} from '../../src/storage/paths'

describe('storage paths', () => {
  it('builds the fixed top-level paths', () => {
    expect(manifestPath('midori')).toBe('midori/manifest.json')
    expect(rosterPath('midori')).toBe('midori/roster.sig.json')
  })

  it('zero-pads the keyring generation so paths sort in order', () => {
    expect(keyringPath('midori', 1)).toBe('midori/keyring/v001.json')
    expect(keyringPath('midori', 42)).toBe('midori/keyring/v042.json')
  })

  it('hashes the login id into the keystore path', async () => {
    const path = await keystorePath('midori', 'sato')
    expect(path).toMatch(/^midori\/users\/[0-9a-f]{64}\.json$/)
    expect(path).not.toContain('sato')
  })

  it('normalizes the login id case and surrounding whitespace', async () => {
    expect(await keystorePath('midori', '  SATO ')).toBe(await keystorePath('midori', 'sato'))
  })

  it('separates keystores across groups for the same login id', async () => {
    expect(await keystorePath('midori', 'sato')).not.toBe(await keystorePath('aozora', 'sato'))
  })

  it('builds content paths', () => {
    expect(messagePath('midori', 'm1')).toBe('midori/messages/m1.enc')
    expect(filePath('midori', 'f1')).toBe('midori/files/f1.enc')
    expect(eventPath('midori', 'e1')).toBe('midori/events/e1.enc')
    expect(inboxPath('midori', 'u_a', 'i1')).toBe('midori/inbox/u_a/i1.enc')
  })
})
