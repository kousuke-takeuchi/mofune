import { describe, it, expect } from 'vitest'
import {
  GrantError,
  SLOTS_PER_GRANT,
  grantPath,
  issueGrant,
  publishGrants,
  readGrant,
} from '../../src/inbox/grants'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { toBase64 } from '../../src/crypto/bytes'
import { MemoryStorageProvider } from '../../src/storage/memory'
import type { StorageSettings } from '../../src/group/storage-credentials'
import type { RosterContents } from '../../src/crypto/roster'

const settings: StorageSettings = {
  provider: 's3',
  endpoint: 'https://example.invalid',
  region: 'auto',
  bucket: 'mofune',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
}
const now = new Date('2026-08-08T09:00:00.000Z')

async function fixture() {
  const member = await generateEcdhKeyPair()
  const staff = await generateEcdhKeyPair()
  const roster: RosterContents = {
    groupId: 'midori',
    generation: 1,
    subgroups: [],
    members: [
      {
        userId: 'u_sato',
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: ['all'],
        ecdhPublic: toBase64(member.publicKey),
        ecdsaPublic: 'x',
      },
      {
        userId: 'u_tanaka',
        displayName: '田中 みか',
        role: 'staff',
        scopes: ['all', 'staff'],
        ecdhPublic: toBase64(staff.publicKey),
        ecdsaPublic: 'x',
      },
    ],
  }
  return { roster, member, staff }
}

describe('grantPath', () => {
  it('places the grant inside the user inbox', () => {
    expect(grantPath('midori', 'u_sato')).toBe('midori/inbox/u_sato/grant.enc')
  })
})

describe('issueGrant', () => {
  it('issues several slots so the member can post more than once', async () => {
    const { member } = await fixture()
    const { grant } = await issueGrant({
      groupId: 'midori',
      userId: 'u_sato',
      ecdhPublic: toBase64(member.publicKey),
      settings,
      now,
    })
    expect(grant.slots).toHaveLength(SLOTS_PER_GRANT)
    expect(SLOTS_PER_GRANT).toBeGreaterThan(1)
  })

  it('gives every slot a distinct randomised key under the user inbox', async () => {
    const { member } = await fixture()
    const { grant } = await issueGrant({
      groupId: 'midori',
      userId: 'u_sato',
      ecdhPublic: toBase64(member.publicKey),
      settings,
      now,
    })
    const keys = grant.slots.map((slot) => slot.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) {
      expect(key).toMatch(/^midori\/inbox\/u_sato\/[0-9a-f]{32}\.enc$/)
    }
  })

  it('signs each slot as a PUT url for its own key', async () => {
    const { member } = await fixture()
    const { grant } = await issueGrant({
      groupId: 'midori',
      userId: 'u_sato',
      ecdhPublic: toBase64(member.publicKey),
      settings,
      now,
    })
    for (const slot of grant.slots) {
      const url = new URL(slot.url)
      expect(url.pathname).toBe(`/mofune/${slot.key}`)
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('records when the grant expires', async () => {
    const { member } = await fixture()
    const { grant } = await issueGrant({
      groupId: 'midori',
      userId: 'u_sato',
      ecdhPublic: toBase64(member.publicKey),
      settings,
      now,
    })
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.parse(grant.issuedAt))
  })

  it('seals the grant so only that member can read the urls', async () => {
    const { member, staff } = await fixture()
    const { sealed } = await issueGrant({
      groupId: 'midori',
      userId: 'u_sato',
      ecdhPublic: toBase64(member.publicKey),
      settings,
      now,
    })
    // presigned URL は能力トークンなので、平文で置いてはならない
    expect(new TextDecoder().decode(sealed)).not.toContain('X-Amz-Signature')
    const storage = new MemoryStorageProvider()
    await storage.put(grantPath('midori', 'u_sato'), sealed)
    await expect(
      readGrant({ storage, groupId: 'midori', userId: 'u_tanaka', ecdhPrivate: staff.privateKey }),
    ).rejects.toThrow()
  })
})

describe('publishGrants', () => {
  it('writes one grant per member and none for staff', async () => {
    const { roster } = await fixture()
    const storage = new MemoryStorageProvider()
    const issued = await publishGrants({ storage, groupId: 'midori', roster, settings, now })
    expect(issued).toEqual(['u_sato'])
    expect(await storage.list('midori/inbox/u_sato/')).toHaveLength(1)
    expect(await storage.list('midori/inbox/u_tanaka/')).toHaveLength(0)
  })

  it('lets the member read back their own grant', async () => {
    const { roster, member } = await fixture()
    const storage = new MemoryStorageProvider()
    await publishGrants({ storage, groupId: 'midori', roster, settings, now })
    const grant = await readGrant({
      storage,
      groupId: 'midori',
      userId: 'u_sato',
      ecdhPrivate: member.privateKey,
    })
    expect(grant.slots).toHaveLength(SLOTS_PER_GRANT)
  })

  it('replaces an older grant rather than accumulating', async () => {
    const { roster } = await fixture()
    const storage = new MemoryStorageProvider()
    await publishGrants({ storage, groupId: 'midori', roster, settings, now })
    await publishGrants({ storage, groupId: 'midori', roster, settings, now })
    expect(await storage.list('midori/inbox/u_sato/')).toHaveLength(1)
  })
})

describe('readGrant', () => {
  it('reports a missing grant clearly', async () => {
    const { member } = await fixture()
    await expect(
      readGrant({
        storage: new MemoryStorageProvider(),
        groupId: 'midori',
        userId: 'u_sato',
        ecdhPrivate: member.privateKey,
      }),
    ).rejects.toThrow(GrantError)
  })
})
