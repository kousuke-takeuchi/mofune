import { describe, it, expect } from 'vitest'
import { ManifestError, encodeManifest, decodeManifest } from '../../src/group/manifest'
import type { Manifest } from '../../src/group/manifest'
import { utf8 } from '../../src/crypto/bytes'

const manifest: Manifest = {
  v: 1,
  groupId: 'midori',
  groupName: 'みどり台グループ',
  keyringGeneration: 1,
  rosterGeneration: 1,
  functionUrl: null,
  notificationChannels: ['mailto'],
}

describe('manifest', () => {
  it('round-trips a manifest', () => {
    expect(decodeManifest(encodeManifest(manifest))).toEqual(manifest)
  })

  it('rejects invalid JSON', () => {
    expect(() => decodeManifest(utf8('{'))).toThrow(ManifestError)
  })

  it('rejects an unknown version', () => {
    expect(() => decodeManifest(utf8(JSON.stringify({ ...manifest, v: 99 })))).toThrow(
      /version/,
    )
  })

  it('rejects a manifest without a keyring generation', () => {
    const bad = JSON.stringify({ ...manifest, keyringGeneration: 'one' })
    expect(() => decodeManifest(utf8(bad))).toThrow(ManifestError)
  })
})
