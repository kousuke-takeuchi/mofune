import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { SubgroupError, createSubgroup, setMemberScopes } from '../../src/group/subgroups'
import { addMember } from '../../src/group/membership'
import { provisionGroup, writeObjects, INITIAL_GENERATION } from '../../src/group/provision'
import { decodeConnectionCode, encodeConnectionCode } from '../../src/group/connection-code'
import type { ConnectionCode } from '../../src/group/connection-code'
import { login } from '../../src/group/session'
import type { Session } from '../../src/group/session'
import { writeStorageSettings } from '../../src/group/storage-credentials'
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

async function fixture(): Promise<{
  storage: MemoryStorageProvider
  code: ConnectionCode
  admin: Session
}> {
  const result = await provisionGroup({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    provider: 's3',
    root: 'https://public.invalid',
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
    ],
  })
  const storage = new MemoryStorageProvider()
  await writeObjects(storage, result.objects)
  const code = decodeConnectionCode(encodeConnectionCode(result.code))
  const admin = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
  await writeStorageSettings({
    storage,
    groupId: 'midori',
    settings,
    staffKey: admin.groupKeys.get(keyId(STAFF_SCOPE, INITIAL_GENERATION)) as CryptoKey,
    generation: INITIAL_GENERATION,
  })
  return { storage, code, admin }
}

async function currentRoster(storage: MemoryStorageProvider, code: ConnectionCode) {
  const file = await loadRosterFile({ storage, groupId: 'midori' })
  return verifyRoster(file, fromBase64(code.adminPublicKey))
}

beforeEach(async () => {
  await registryDb.groups.clear()
})

describe('createSubgroup', () => {
  it('adds a subgroup anyone can be put into', async () => {
    const { storage, code, admin } = await fixture()
    const { id } = await createSubgroup({
      storage,
      session: admin,
      code,
      name: 'Aチーム',
      parent: null,
    })

    const roster = await currentRoster(storage, code)
    expect(roster.subgroups).toEqual([{ id, name: 'Aチーム', parent: null }])
  })

  it('nests one subgroup inside another', async () => {
    const { storage, code, admin } = await fixture()
    const parent = await createSubgroup({
      storage,
      session: admin,
      code,
      name: 'Aチーム',
      parent: null,
    })
    const again = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
    const child = await createSubgroup({
      storage,
      session: again,
      code,
      name: '送迎係',
      parent: parent.id,
    })

    const roster = await currentRoster(storage, code)
    expect(roster.subgroups.find((group) => group.id === child.id)?.parent).toBe(parent.id)
  })

  it('refuses a parent that does not exist', async () => {
    const { storage, code, admin } = await fixture()
    await expect(
      createSubgroup({ storage, session: admin, code, name: 'x', parent: 'sg_missing' }),
    ).rejects.toThrow(SubgroupError)
  })

  it('refuses an empty name', async () => {
    const { storage, code, admin } = await fixture()
    await expect(
      createSubgroup({ storage, session: admin, code, name: '   ', parent: null }),
    ).rejects.toThrow(SubgroupError)
  })

  it('refuses anyone but an admin', async () => {
    const { storage, code, admin } = await fixture()
    const staff = { ...admin, role: 'staff' } as Session
    await expect(
      createSubgroup({ storage, session: staff, code, name: 'Aチーム', parent: null }),
    ).rejects.toThrow(SubgroupError)
  })
})

describe('setMemberScopes', () => {
  it('gives a member the key of the subgroup they are moved into', async () => {
    const { storage, code, admin } = await fixture()
    const team = await createSubgroup({
      storage,
      session: admin,
      code,
      name: 'Aチーム',
      parent: null,
    })
    let session = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
    const { userId } = await addMember({
      storage,
      session,
      code,
      settings,
      kdf: TEST_KDF,
      member: {
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: [],
        password: 'member-pass',
        email: 'sato@example.invalid',
      },
    })

    session = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
    await setMemberScopes({ storage, session, code, settings, userId, scopes: [team.id] })

    const sato = await login({ code, email: 'sato@example.invalid', password: 'member-pass', storage })
    expect(sato.groupKeys.has(keyId(team.id, INITIAL_GENERATION))).toBe(true)
  })

  it('records the move on the roster', async () => {
    const { storage, code, admin } = await fixture()
    const team = await createSubgroup({
      storage,
      session: admin,
      code,
      name: 'Aチーム',
      parent: null,
    })
    let session = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
    const { userId } = await addMember({
      storage,
      session,
      code,
      settings,
      kdf: TEST_KDF,
      member: {
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: [],
        password: 'member-pass',
        email: 'person3@example.invalid',
      },
    })
    session = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
    await setMemberScopes({ storage, session, code, settings, userId, scopes: [team.id] })

    const roster = await currentRoster(storage, code)
    const moved = roster.members.find((member) => member.userId === userId)
    expect(moved?.scopes).toContain(team.id)
  })

  it('refuses to move someone who is not on the roster', async () => {
    const { storage, code, admin } = await fixture()
    await expect(
      setMemberScopes({
        storage,
        session: admin,
        code,
        settings,
        userId: 'u_nobody',
        scopes: [],
      }),
    ).rejects.toThrow(SubgroupError)
  })
})
