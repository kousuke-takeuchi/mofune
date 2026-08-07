import { describe, it, expect } from 'vitest'
import {
  StorageCredentialsError,
  readStorageSettings,
  storageSettingsPath,
  toProviderConfig,
  writeStorageSettings,
} from '../../src/group/storage-credentials'
import type { StorageSettings } from '../../src/group/storage-credentials'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { keyId } from '../../src/crypto/keyring'
import { STAFF_SCOPE } from '../../src/crypto/roster'

const settings: StorageSettings = {
  provider: 's3',
  endpoint: 'https://account.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'mofune',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
}

async function seeded(): Promise<{
  storage: MemoryStorageProvider
  staffKey: CryptoKey
  staffKeyId: string
}> {
  const storage = new MemoryStorageProvider()
  const staffKey = await generateAesKey()
  const staffKeyId = keyId(STAFF_SCOPE, 1)
  await writeStorageSettings({ storage, groupId: 'midori', settings, staffKey, generation: 1 })
  return { storage, staffKey, staffKeyId }
}

describe('storage settings', () => {
  it('writes to the documented path', () => {
    expect(storageSettingsPath('midori')).toBe('midori/settings/storage.enc')
  })

  it('round-trips the settings for a staff key holder', async () => {
    const { storage, staffKey, staffKeyId } = await seeded()
    const keys = new Map([[staffKeyId, staffKey]])
    expect(await readStorageSettings({ storage, groupId: 'midori', keys })).toEqual(settings)
  })

  it('addresses the object to the staff scope only', async () => {
    const { storage } = await seeded()
    const { readKeyIds } = await import('../../src/crypto/envelope')
    expect(readKeyIds(await storage.get(storageSettingsPath('midori')))).toEqual([
      keyId(STAFF_SCOPE, 1),
    ])
  })

  it('cannot be read by a member who holds only the all scope key', async () => {
    const { storage } = await seeded()
    const keys = new Map([[keyId('all', 1), await generateAesKey()]])
    await expect(readStorageSettings({ storage, groupId: 'midori', keys })).rejects.toThrow(
      StorageCredentialsError,
    )
  })

  it('does not leave the secret access key in plaintext on storage', async () => {
    const { storage } = await seeded()
    const raw = new TextDecoder().decode(await storage.get(storageSettingsPath('midori')))
    expect(raw).not.toContain('SECRET')
    expect(raw).not.toContain('AKID')
  })

  it('reports a missing settings object as a credentials error', async () => {
    const storage = new MemoryStorageProvider()
    const keys = new Map([[keyId(STAFF_SCOPE, 1), await generateAesKey()]])
    await expect(readStorageSettings({ storage, groupId: 'midori', keys })).rejects.toThrow(
      StorageCredentialsError,
    )
  })

  it('converts settings into a provider config', () => {
    expect(toProviderConfig(settings)).toEqual({
      endpoint: 'https://account.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'mofune',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
    })
  })

  it('can be replaced by writing a newer generation', async () => {
    const { storage } = await seeded()
    const rotated: StorageSettings = { ...settings, accessKeyId: 'AKID2', secretAccessKey: 'S2' }
    const newKey = await generateAesKey()
    await writeStorageSettings({
      storage,
      groupId: 'midori',
      settings: rotated,
      staffKey: newKey,
      generation: 2,
    })
    const keys = new Map([[keyId(STAFF_SCOPE, 2), newKey]])
    expect(await readStorageSettings({ storage, groupId: 'midori', keys })).toEqual(rotated)
  })
})
