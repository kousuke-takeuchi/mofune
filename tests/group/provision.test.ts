import type { Bytes } from '../../src/crypto/bytes'
import { describe, it, expect } from 'vitest'
import { provisionGroup, writeObjects } from '../../src/group/provision'
import type { NewMember, ProvisionOptions } from '../../src/group/provision'
import { TEST_KDF } from '../../src/crypto/kdf'
import { parseKeystoreFile, unlockKeystore } from '../../src/crypto/keystore'
import { parseKeyringFile, unlockKeyring } from '../../src/crypto/keyring'
import { ALL_SCOPE, STAFF_SCOPE, parseRosterFile, verifyRoster } from '../../src/crypto/roster'
import { openEnvelopeWithKey } from '../../src/crypto/envelope'
import { decodeManifest } from '../../src/group/manifest'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { keyringPath, keystorePath, manifestPath, rosterPath } from '../../src/storage/paths'
import { fromBase64, fromUtf8 } from '../../src/crypto/bytes'

const options: ProvisionOptions = {
  groupId: 'midori',
  groupName: 'みどり台グループ',
  provider: 'http',
  root: 'https://example.invalid/mofune',
  kdf: TEST_KDF,
  subgroups: [
    { id: 'sg_a', name: 'Aチーム', parent: null },
    { id: 'sg_a_pickup', name: '送迎係', parent: 'sg_a' },
  ],
  members: [
    {
      loginId: 'watanabe',
      displayName: '渡辺 けい',
      role: 'admin',
      scopes: [],
      password: 'admin-pass',
      email: 'watanabe@example.invalid',
    },
    {
      loginId: 'tanaka',
      displayName: '田中 みか',
      role: 'staff',
      scopes: ['sg_a'],
      password: 'staff-pass',
      email: 'tanaka@example.invalid',
    },
    {
      loginId: 'sato',
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: ['sg_a'],
      password: 'member-pass',
      email: 'sato@example.invalid',
    },
    {
      loginId: 'mori',
      displayName: '森 ゆい',
      role: 'member',
      scopes: ['sg_a_pickup'],
      password: 'member-pass',
      email: 'mori@example.invalid',
    },
  ],
}

describe('provisionGroup', () => {
  it('emits a connection code carrying the pepper and the admin public key', async () => {
    const result = await provisionGroup(options)
    expect(result.code.groupId).toBe('midori')
    expect(result.code.provider).toBe('http')
    expect(result.code.pepper.length).toBeGreaterThan(0)
    expect(result.code.adminPublicKey.length).toBeGreaterThan(0)
  })

  it('writes a manifest, a roster, a keyring and one keystore per member', async () => {
    const result = await provisionGroup(options)
    expect(result.objects.has(manifestPath('midori'))).toBe(true)
    expect(result.objects.has(rosterPath('midori'))).toBe(true)
    expect(result.objects.has(keyringPath('midori', 1))).toBe(true)
    for (const member of options.members) {
      expect(result.objects.has(await keystorePath('midori', member.loginId))).toBe(true)
    }
  })

  it('produces a roster that verifies against the connection code admin key', async () => {
    const result = await provisionGroup(options)
    const file = parseRosterFile(result.objects.get(rosterPath('midori')) as Bytes)
    const roster = await verifyRoster(file, fromBase64(result.code.adminPublicKey))
    expect(roster.members.map((m) => m.displayName).sort()).toEqual(
      ['佐藤 さくら', '渡辺 けい', '田中 みか', '森 ゆい'].sort(),
    )
    expect(roster.subgroups.map((s) => s.id).sort()).toEqual(['sg_a', 'sg_a_pickup'])
  })

  it('grants the all scope to everyone and the staff scope only to staff', async () => {
    const result = await provisionGroup(options)
    const file = parseRosterFile(result.objects.get(rosterPath('midori')) as Bytes)
    const roster = await verifyRoster(file, fromBase64(result.code.adminPublicKey))
    const byName = (name: string) =>
      roster.members.find((m) => m.displayName === name)?.scopes ?? []
    expect(byName('佐藤 さくら')).toContain(ALL_SCOPE)
    expect(byName('佐藤 さくら')).not.toContain(STAFF_SCOPE)
    expect(byName('田中 みか')).toContain(STAFF_SCOPE)
    expect(byName('渡辺 けい')).toContain(STAFF_SCOPE)
  })

  it('gives a member the all and subgroup keys but not the staff key', async () => {
    const result = await provisionGroup(options)
    const keystore = await unlockKeystore(
      parseKeystoreFile(
        result.objects.get(await keystorePath('midori', 'sato')) as Bytes,
      ),
      'member-pass',
      result.code.pepper,
    )
    const keyring = parseKeyringFile(
      result.objects.get(keyringPath('midori', 1)) as Bytes,
    )
    const keys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)
    expect([...keys.keys()].sort()).toEqual(['all:v1', 'sg_a:v1'])
  })

  it('gives a nested subgroup member both the child and the parent key', async () => {
    const result = await provisionGroup(options)
    const keystore = await unlockKeystore(
      parseKeystoreFile(
        result.objects.get(await keystorePath('midori', 'mori')) as Bytes,
      ),
      'member-pass',
      result.code.pepper,
    )
    const keyring = parseKeyringFile(
      result.objects.get(keyringPath('midori', 1)) as Bytes,
    )
    const keys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)
    expect([...keys.keys()].sort()).toEqual(['all:v1', 'sg_a:v1', 'sg_a_pickup:v1'])
  })

  it('does not give a parent subgroup member the child subgroup key', async () => {
    const result = await provisionGroup(options)
    const keystore = await unlockKeystore(
      parseKeystoreFile(
        result.objects.get(await keystorePath('midori', 'sato')) as Bytes,
      ),
      'member-pass',
      result.code.pepper,
    )
    const keyring = parseKeyringFile(
      result.objects.get(keyringPath('midori', 1)) as Bytes,
    )
    const keys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)
    expect(keys.has('sg_a_pickup:v1')).toBe(false)
  })

  it('rejects a member assigned to an unknown subgroup', async () => {
    const member = options.members.find((m) => m.loginId === 'sato') as NewMember
    await expect(
      provisionGroup({
        ...options,
        members: options.members.map((m) =>
          m.loginId === member.loginId ? { ...m, scopes: ['sg_zzz'] } : m,
        ),
      }),
    ).rejects.toThrow(/sg_zzz/)
  })

  it('lets staff decrypt the contact list while members cannot', async () => {
    const result = await provisionGroup(options)
    const rosterFile = parseRosterFile(result.objects.get(rosterPath('midori')) as Bytes)
    const keyring = parseKeyringFile(
      result.objects.get(keyringPath('midori', 1)) as Bytes,
    )

    const staff = await unlockKeystore(
      parseKeystoreFile(
        result.objects.get(await keystorePath('midori', 'tanaka')) as Bytes,
      ),
      'staff-pass',
      result.code.pepper,
    )
    const staffKeys = await unlockKeyring(keyring, staff.userId, staff.ecdh.privateKey)
    const staffKey = staffKeys.get('staff:v1') as CryptoKey
    const contacts = JSON.parse(
      fromUtf8(
        await openEnvelopeWithKey(staffKey, fromBase64(rosterFile.staffSection as string)),
      ),
    ) as Record<string, { email: string }>
    expect(Object.values(contacts).map((c) => c.email)).toContain('sato@example.invalid')

    const member = await unlockKeystore(
      parseKeystoreFile(
        result.objects.get(await keystorePath('midori', 'sato')) as Bytes,
      ),
      'member-pass',
      result.code.pepper,
    )
    const memberKeys = await unlockKeyring(keyring, member.userId, member.ecdh.privateKey)
    expect(memberKeys.has('staff:v1')).toBe(false)
  })

  it('records the keyring generation in the manifest', async () => {
    const result = await provisionGroup(options)
    const manifest = decodeManifest(result.objects.get(manifestPath('midori')) as Bytes)
    expect(manifest.keyringGeneration).toBe(1)
    expect(manifest.groupName).toBe('みどり台グループ')
  })

  it('rejects a member set without exactly one admin', async () => {
    await expect(
      provisionGroup({ ...options, members: options.members.filter((m) => m.role !== 'admin') }),
    ).rejects.toThrow(/admin/)
  })

  it('rejects duplicate login ids', async () => {
    const member = options.members.find((member) => member.role === 'member') as NewMember
    await expect(
      provisionGroup({ ...options, members: [...options.members, { ...member }] }),
    ).rejects.toThrow(/duplicate/)
  })

  it('writes every object into a storage provider', async () => {
    const result = await provisionGroup(options)
    const storage = new MemoryStorageProvider()
    await writeObjects(storage, result.objects)
    expect((await storage.list('midori/')).length).toBe(result.objects.size)
  })
})
