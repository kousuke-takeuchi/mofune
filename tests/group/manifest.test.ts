import { describe, it, expect } from 'vitest'
import {
  ManifestError,
  encodeManifest,
  decodeManifest,
  setFunctionUrl,
} from '../../src/group/manifest'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { manifestPath } from '../../src/storage/paths'
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

describe('setFunctionUrl', () => {
  it('writes the url the participants read before logging in', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put(
      manifestPath('g_midori'),
      encodeManifest({
        v: 1,
        groupId: 'g_midori',
        groupName: 'みどり台',
        keyringGeneration: 1,
        rosterGeneration: 1,
        functionUrl: null,
        notificationChannels: ['mailto'],
      }),
    )

    await setFunctionUrl({ storage, groupId: 'g_midori', functionUrl: 'https://push.invalid/' })

    const manifest = decodeManifest(await storage.get(manifestPath('g_midori')))
    // 末尾のスラッシュは落として持つ。付いたり付かなかったりすると URL を作るたびに揺れる
    expect(manifest.functionUrl).toBe('https://push.invalid')
    expect(manifest.groupName).toBe('みどり台')
  })

  it('can take the function away again', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put(
      manifestPath('g_midori'),
      encodeManifest({
        v: 1,
        groupId: 'g_midori',
        groupName: 'みどり台',
        keyringGeneration: 1,
        rosterGeneration: 1,
        functionUrl: 'https://push.invalid',
        notificationChannels: ['mailto'],
      }),
    )

    await setFunctionUrl({ storage, groupId: 'g_midori', functionUrl: '' })

    expect(decodeManifest(await storage.get(manifestPath('g_midori'))).functionUrl).toBeNull()
  })
})
