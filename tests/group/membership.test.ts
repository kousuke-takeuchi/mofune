import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { MembershipError, addMember, reissuePassword } from '../../src/group/membership'
import { provisionGroup, writeObjects, INITIAL_GENERATION } from '../../src/group/provision'
import { decodeConnectionCode, encodeConnectionCode } from '../../src/group/connection-code'
import type { ConnectionCode } from '../../src/group/connection-code'
import { login } from '../../src/group/session'
import type { Session } from '../../src/group/session'
import { writeStorageSettings } from '../../src/group/storage-credentials'
import { readContacts } from '../../src/group/contacts'
import { loadRosterFile } from '../../src/group/roster-update'
import { verifyRoster } from '../../src/crypto/roster'
import { keyId } from '../../src/crypto/keyring'
import { STAFF_SCOPE } from '../../src/crypto/roster'
import { TEST_KDF } from '../../src/crypto/kdf'
import { fromBase64 } from '../../src/crypto/bytes'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { registryDb } from '../../src/db/groups'

const settings = {
  provider: 's3' as const,
  endpoint: 'https://s3.invalid',
  region: 'auto',
  bucket: 'mofune',
  publicBaseUrl: 'https://public.invalid',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
}

interface Fixture {
  storage: MemoryStorageProvider
  code: ConnectionCode
  admin: Session
}

async function fixture(): Promise<Fixture> {
  const result = await provisionGroup({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    provider: 's3',
    root: 'https://public.invalid',
    kdf: TEST_KDF,
    subgroups: [{ id: 'sg_a', name: 'Aチーム', parent: null }],
    members: [
      {
        displayName: '渡辺 けい',
        role: 'admin',
        scopes: [],
        password: 'admin-pass',
        email: 'watanabe@example.invalid',
      },
    ],
  })
  const storage = new MemoryStorageProvider()
  await writeObjects(storage, result.objects)
  const code = decodeConnectionCode(encodeConnectionCode(result.code))
  const admin = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
  const staffKey = admin.groupKeys.get(keyId(STAFF_SCOPE, INITIAL_GENERATION)) as CryptoKey
  await writeStorageSettings({
    storage,
    groupId: 'midori',
    settings,
    staffKey,
    generation: INITIAL_GENERATION,
  })
  return { storage, code, admin }
}

function newcomer() {
  return {
    displayName: '佐藤 さくら',
    role: 'member' as const,
    scopes: ['sg_a'],
    password: 'member-pass',
    email: 'sato@example.invalid',
  }
}

beforeEach(async () => {
  await registryDb.groups.clear()
})

describe('addMember', () => {
  it('lets the new member sign in with the password they were handed', async () => {
    const { storage, code, admin } = await fixture()
    await addMember({ storage, session: admin, code, settings, member: newcomer(), kdf: TEST_KDF })

    const session = await login({ code, email: 'sato@example.invalid', password: 'member-pass', storage })
    expect(session.displayName).toBe('佐藤 さくら')
    expect(session.role).toBe('member')
  })

  it('gives the new member the keys for the scopes they belong to', async () => {
    const { storage, code, admin } = await fixture()
    await addMember({ storage, session: admin, code, settings, member: newcomer(), kdf: TEST_KDF })

    const session = await login({ code, email: 'sato@example.invalid', password: 'member-pass', storage })
    expect([...session.groupKeys.keys()].sort()).toEqual(['all:v1', 'sg_a:v1'])
  })

  it('does not hand a participant the staff key', async () => {
    const { storage, code, admin } = await fixture()
    await addMember({ storage, session: admin, code, settings, member: newcomer(), kdf: TEST_KDF })

    const session = await login({ code, email: 'sato@example.invalid', password: 'member-pass', storage })
    expect(session.groupKeys.has('staff:v1')).toBe(false)
  })

  it('keeps everyone who was already there', async () => {
    const { storage, code, admin } = await fixture()
    await addMember({ storage, session: admin, code, settings, member: newcomer(), kdf: TEST_KDF })

    const again = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
    expect(again.groupKeys.has('staff:v1')).toBe(true)
    expect(again.roster.members).toHaveLength(2)
  })

  it('records the contact where only staff can read it', async () => {
    const { storage, code, admin } = await fixture()
    const { userId } = await addMember({
      storage,
      session: admin,
      code,
      settings,
      member: newcomer(),
      kdf: TEST_KDF,
    })

    const again = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
    const file = await loadRosterFile({ storage, groupId: 'midori' })
    const contacts = await readContacts({
      file,
      staffKey: again.groupKeys.get(keyId(STAFF_SCOPE, INITIAL_GENERATION)) as CryptoKey,
    })
    expect(contacts[userId]?.email).toBe('sato@example.invalid')
  })

  it('moves the roster on a generation and keeps it verifiable', async () => {
    const { storage, code, admin } = await fixture()
    await addMember({ storage, session: admin, code, settings, member: newcomer(), kdf: TEST_KDF })

    const file = await loadRosterFile({ storage, groupId: 'midori' })
    const roster = await verifyRoster(file, fromBase64(code.adminPublicKey))
    expect(roster.generation).toBe(INITIAL_GENERATION + 1)
  })

  it('issues an inbox grant so the newcomer can reply', async () => {
    const { storage, code, admin } = await fixture()
    const { userId } = await addMember({
      storage,
      session: admin,
      code,
      settings,
      member: newcomer(),
      kdf: TEST_KDF,
    })
    expect(await storage.list(`midori/inbox/${userId}/`)).toHaveLength(1)
  })

  it('refuses a login id that is already taken', async () => {
    const { storage, code, admin } = await fixture()
    await expect(
      addMember({
        storage,
        session: admin,
        code,
        settings,
        member: { ...newcomer(), email: 'watanabe@example.invalid' },
        kdf: TEST_KDF,
      }),
    ).rejects.toThrow(MembershipError)
  })

  it('refuses anyone but an admin, who alone can re-sign the roster', async () => {
    const { storage, code, admin } = await fixture()
    const notAdmin = { ...admin, role: 'staff' } as Session
    await expect(
      addMember({ storage, session: notAdmin, code, settings, member: newcomer(), kdf: TEST_KDF }),
    ).rejects.toThrow(MembershipError)
  })
})

describe('reissuePassword', () => {
  it('lets the member in with the new password', async () => {
    const { storage, code, admin } = await fixture()
    const { userId } = await addMember({
      storage,
      session: admin,
      code,
      settings,
      member: newcomer(),
      kdf: TEST_KDF,
    })

    const again = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
    await reissuePassword({
      storage,
      session: again,
      code,
      settings,
      userId,
      email: 'sato@example.invalid',
      password: 'brand-new-pass',
      kdf: TEST_KDF,
    })

    const session = await login({ code, email: 'sato@example.invalid', password: 'brand-new-pass', storage })
    expect(session.userId).toBe(userId)
    expect([...session.groupKeys.keys()].sort()).toEqual(['all:v1', 'sg_a:v1'])
  })

  it('closes the door on the password that was replaced', async () => {
    const { storage, code, admin } = await fixture()
    const { userId } = await addMember({
      storage,
      session: admin,
      code,
      settings,
      member: newcomer(),
      kdf: TEST_KDF,
    })
    const again = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
    await reissuePassword({
      storage,
      session: again,
      code,
      settings,
      userId,
      email: 'sato@example.invalid',
      password: 'brand-new-pass',
      kdf: TEST_KDF,
    })

    await expect(
      login({ code, email: 'sato@example.invalid', password: 'member-pass', storage }),
    ).rejects.toThrow()
  })
})
