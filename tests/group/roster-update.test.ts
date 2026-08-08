import { describe, it, expect } from 'vitest'
import { RosterUpdateError, loadRosterFile, updateContacts } from '../../src/group/roster-update'
import { readContacts } from '../../src/group/contacts'
import { provisionGroup } from '../../src/group/provision'
import { parseKeystoreFile, unlockKeystore } from '../../src/crypto/keystore'
import { parseKeyringFile, unlockKeyring } from '../../src/crypto/keyring'
import { verifyRoster } from '../../src/crypto/roster'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { keyringPath, keystorePath, rosterPath } from '../../src/storage/paths'
import { fromBase64 } from '../../src/crypto/bytes'
import type { Bytes } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'

async function provisioned() {
  const result = await provisionGroup({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    provider: 'http',
    root: 'https://example.invalid/mofune',
    kdf: TEST_KDF,
    subgroups: [],
    members: [
      {
        displayName: '渡辺 けい',
        role: 'admin',
        scopes: [],
        password: 'admin-pass',
        email: 'watanabe@example.invalid',
      },
      {
        displayName: '田中 みか',
        role: 'staff',
        scopes: [],
        password: 'staff-pass',
        email: 'tanaka@example.invalid',
      },
      {
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: [],
        password: 'member-pass',
        email: 'person1@example.invalid',
      },
    ],
  })
  const storage = new MemoryStorageProvider()
  for (const [path, body] of result.objects) await storage.put(path, body)

  const open = async (email: string, password: string) => {
    const keystore = await unlockKeystore(
      parseKeystoreFile(result.objects.get(await keystorePath('midori', email)) as Bytes),
      password,
      result.code.pepper,
    )
    const keyring = parseKeyringFile(result.objects.get(keyringPath('midori', 1)) as Bytes)
    const keys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)
    return { keystore, keys }
  }

  const admin = await open('watanabe@example.invalid', 'admin-pass')
  const staff = await open('tanaka@example.invalid', 'staff-pass')
  const satoUserId = (
    await verifyRoster(
      (await import('../../src/crypto/roster')).parseRosterFile(
        result.objects.get(rosterPath('midori')) as Bytes,
      ),
      fromBase64(result.code.adminPublicKey),
    )
  ).members.find((m) => m.displayName === '佐藤 さくら')?.userId as string

  const sessionFor = (
    who: typeof admin,
    role: 'admin' | 'staff',
    displayName: string,
  ): Session => ({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: who.keystore.userId,
    displayName,
    role,
    scopes: ['all', 'staff'],
    groupKeys: who.keys,
    generation: 1,
    roster: { groupId: 'midori', generation: 1, subgroups: [], members: [] },
    ecdhPrivate: who.keystore.ecdh.privateKey,
    ecdsaPrivate: who.keystore.ecdsa.privateKey,
  })

  return {
    storage,
    code: result.code,
    adminPublicKey: fromBase64(result.code.adminPublicKey),
    adminSession: sessionFor(admin, 'admin', '渡辺 けい'),
    staffSession: sessionFor(staff, 'staff', '田中 みか'),
    staffKey: admin.keys.get('staff:v1') as CryptoKey,
    satoUserId,
  }
}

describe('loadRosterFile', () => {
  it('reads the roster written at provisioning time', async () => {
    const { storage } = await provisioned()
    const file = await loadRosterFile({ storage, groupId: 'midori' })
    expect(file.staffSection).not.toBeNull()
  })

  it('reports a missing roster', async () => {
    await expect(
      loadRosterFile({ storage: new MemoryStorageProvider(), groupId: 'midori' }),
    ).rejects.toThrow(RosterUpdateError)
  })
})

describe('updateContacts', () => {
  it('adds the address to the contact book', async () => {
    const ctx = await provisioned()
    const result = await updateContacts({
      storage: ctx.storage,
      session: ctx.adminSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [{ userId: ctx.satoUserId, email: 'sakura@example.com' }],
    })
    expect(result.contacts[ctx.satoUserId]?.email).toBe('sakura@example.com')
  })

  it('writes a roster that still verifies against the connection code key', async () => {
    const ctx = await provisioned()
    await updateContacts({
      storage: ctx.storage,
      session: ctx.adminSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [{ userId: ctx.satoUserId, email: 'sakura@example.com' }],
    })
    const file = await loadRosterFile({ storage: ctx.storage, groupId: 'midori' })
    await expect(verifyRoster(file, ctx.adminPublicKey)).resolves.toBeDefined()
  })

  it('keeps the addresses that were already there', async () => {
    const ctx = await provisioned()
    const result = await updateContacts({
      storage: ctx.storage,
      session: ctx.adminSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [{ userId: ctx.satoUserId, email: 'sakura@example.com' }],
    })
    expect(Object.values(result.contacts).map((c) => c.email)).toContain(
      'watanabe@example.invalid',
    )
  })

  it('advances the roster generation', async () => {
    const ctx = await provisioned()
    const result = await updateContacts({
      storage: ctx.storage,
      session: ctx.adminSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [{ userId: ctx.satoUserId, email: 'sakura@example.com' }],
    })
    expect(result.generation).toBe(2)
    const file = await loadRosterFile({ storage: ctx.storage, groupId: 'midori' })
    const contents = await verifyRoster(file, ctx.adminPublicKey)
    expect(contents.generation).toBe(2)
  })

  it('keeps the contact section readable with the staff key', async () => {
    const ctx = await provisioned()
    await updateContacts({
      storage: ctx.storage,
      session: ctx.adminSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [{ userId: ctx.satoUserId, email: 'sakura@example.com' }],
    })
    const file = await loadRosterFile({ storage: ctx.storage, groupId: 'midori' })
    const book = await readContacts({ file, staffKey: ctx.staffKey })
    expect(book[ctx.satoUserId]?.email).toBe('sakura@example.com')
  })

  it('applies several updates at once', async () => {
    const ctx = await provisioned()
    const result = await updateContacts({
      storage: ctx.storage,
      session: ctx.adminSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [
        { userId: ctx.satoUserId, email: 'sakura@example.com' },
        { userId: ctx.satoUserId, email: 'sakura2@example.com' },
      ],
    })
    expect(result.contacts[ctx.satoUserId]?.email).toBe('sakura2@example.com')
  })

  it('refuses when a staff member tries to re-sign the roster', async () => {
    const ctx = await provisioned()
    await expect(
      updateContacts({
        storage: ctx.storage,
        session: ctx.staffSession,
        adminPublicKey: ctx.adminPublicKey,
        staffKey: ctx.staffKey,
        generation: 1,
        updates: [{ userId: ctx.satoUserId, email: 'sakura@example.com' }],
      }),
    ).rejects.toThrow(RosterUpdateError)
  })

  it('leaves the stored roster untouched when it refuses', async () => {
    const ctx = await provisioned()
    const before = await loadRosterFile({ storage: ctx.storage, groupId: 'midori' })
    await updateContacts({
      storage: ctx.storage,
      session: ctx.staffSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [{ userId: ctx.satoUserId, email: 'x@example.com' }],
    }).catch(() => undefined)
    const after = await loadRosterFile({ storage: ctx.storage, groupId: 'midori' })
    expect(after.signature).toBe(before.signature)
  })

  it('refuses when the admin key does not match the connection code', async () => {
    const ctx = await provisioned()
    const { generateEcdsaKeyPair } = await import('../../src/crypto/asymmetric')
    const impostor = await generateEcdsaKeyPair()
    await expect(
      updateContacts({
        storage: ctx.storage,
        session: { ...ctx.adminSession, ecdsaPrivate: impostor.privateKey },
        adminPublicKey: ctx.adminPublicKey,
        staffKey: ctx.staffKey,
        generation: 1,
        updates: [{ userId: ctx.satoUserId, email: 'x@example.com' }],
      }),
    ).rejects.toThrow(RosterUpdateError)
  })
})
