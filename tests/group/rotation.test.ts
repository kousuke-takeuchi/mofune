import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { RotationError, removeMember } from '../../src/group/rotation'
import { addMember } from '../../src/group/membership'
import { createSubgroup, setMemberScopes } from '../../src/group/subgroups'
import { provisionGroup, writeObjects, INITIAL_GENERATION } from '../../src/group/provision'
import { decodeConnectionCode, encodeConnectionCode } from '../../src/group/connection-code'
import type { ConnectionCode } from '../../src/group/connection-code'
import { login } from '../../src/group/session'
import type { Session } from '../../src/group/session'
import { writeStorageSettings } from '../../src/group/storage-credentials'
import { decodeManifest } from '../../src/group/manifest'
import { loadRosterFile } from '../../src/group/roster-update'
import { verifyRoster, STAFF_SCOPE, ALL_SCOPE } from '../../src/crypto/roster'
import { keyId } from '../../src/crypto/keyring'
import { TEST_KDF } from '../../src/crypto/kdf'
import { fromBase64 } from '../../src/crypto/bytes'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { manifestPath } from '../../src/storage/paths'
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

interface World {
  storage: MemoryStorageProvider
  code: ConnectionCode
  admin: Session
  satoUserId: string
}

async function world(): Promise<World> {
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
  let admin = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
  await writeStorageSettings({
    storage,
    groupId: 'midori',
    settings,
    staffKey: admin.groupKeys.get(keyId(STAFF_SCOPE, INITIAL_GENERATION)) as CryptoKey,
    generation: INITIAL_GENERATION,
  })

  const { userId: satoUserId } = await addMember({
    storage,
    session: admin,
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
  admin = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
  return { storage, code, admin, satoUserId }
}

beforeEach(async () => {
  await registryDb.groups.clear()
})

describe('removeMember', () => {
  it('shuts the door: the removed member can no longer sign in', async () => {
    const { storage, code, admin, satoUserId } = await world()
    await removeMember({ storage, session: admin, code, settings, userId: satoUserId, kdf: TEST_KDF })

    await expect(
      login({ code, email: 'sato@example.invalid', password: 'member-pass', storage }),
    ).rejects.toThrow()
  })

  it('takes them off the roster', async () => {
    const { storage, code, admin, satoUserId } = await world()
    await removeMember({ storage, session: admin, code, settings, userId: satoUserId, kdf: TEST_KDF })

    const roster = await verifyRoster(
      await loadRosterFile({ storage, groupId: 'midori' }),
      fromBase64(code.adminPublicKey),
    )
    expect(roster.members.map((member) => member.userId)).not.toContain(satoUserId)
  })

  it('makes a new generation of the keys they held', async () => {
    // 抜けた人は古い鍵を持ったままなので、鍵そのものを取り替えないと
    // これから配るものまで読まれてしまう。
    const { storage, code, admin, satoUserId } = await world()
    await removeMember({ storage, session: admin, code, settings, userId: satoUserId, kdf: TEST_KDF })

    const manifest = decodeManifest(await storage.get(manifestPath('midori')))
    expect(manifest.keyringGeneration).toBe(INITIAL_GENERATION + 1)
  })

  it('keeps the people who stayed able to read what came before', async () => {
    // 世代を上げても、古い鍵を配り続けないと過去のお知らせが読めなくなる。
    const { storage, code, admin, satoUserId } = await world()
    await removeMember({ storage, session: admin, code, settings, userId: satoUserId, kdf: TEST_KDF })

    const again = await login({
      code,
      email: 'watanabe@example.invalid',
      password: 'admin-pass',
      storage,
    })
    expect(again.groupKeys.has(keyId(ALL_SCOPE, INITIAL_GENERATION))).toBe(true)
    expect(again.groupKeys.has(keyId(ALL_SCOPE, INITIAL_GENERATION + 1))).toBe(true)
    expect(again.generation).toBe(INITIAL_GENERATION + 1)
  })

  it('does not hand the new keys to the person who left', async () => {
    const { storage, code, admin, satoUserId } = await world()
    await removeMember({ storage, session: admin, code, settings, userId: satoUserId, kdf: TEST_KDF })

    const { parseKeyringFile } = await import('../../src/crypto/keyring')
    const { keyringPath } = await import('../../src/storage/paths')
    const keyring = parseKeyringFile(
      await storage.get(keyringPath('midori', INITIAL_GENERATION + 1)),
    )
    for (const entry of Object.values(keyring.keys)) {
      if (entry.generation !== INITIAL_GENERATION + 1) continue
      expect(Object.keys(entry.wrapped)).not.toContain(satoUserId)
    }
  })

  it('rotates the subgroup keys the member held as well', async () => {
    const { storage, code, admin, satoUserId } = await world()
    const team = await createSubgroup({ storage, session: admin, code, name: 'Aチーム', parent: null })
    let session = await login({
      code,
      email: 'watanabe@example.invalid',
      password: 'admin-pass',
      storage,
    })
    await setMemberScopes({ storage, session, code, settings, userId: satoUserId, scopes: [team.id] })

    session = await login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
    await removeMember({ storage, session, code, settings, userId: satoUserId, kdf: TEST_KDF })

    const after = await login({
      code,
      email: 'watanabe@example.invalid',
      password: 'admin-pass',
      storage,
    })
    expect(after.groupKeys.has(keyId(team.id, after.generation))).toBe(true)
  })

  it('refuses to remove the only admin', async () => {
    // 名簿を再署名できる人がいなくなると、そのグループは二度と直せない。
    const { storage, code, admin } = await world()
    await expect(
      removeMember({
        storage,
        session: admin,
        code,
        settings,
        userId: admin.userId,
        kdf: TEST_KDF,
      }),
    ).rejects.toThrow(RotationError)
  })

  it('refuses anyone but an admin', async () => {
    const { storage, code, admin, satoUserId } = await world()
    const staff = { ...admin, role: 'staff' } as Session
    await expect(
      removeMember({ storage, session: staff, code, settings, userId: satoUserId, kdf: TEST_KDF }),
    ).rejects.toThrow(RotationError)
  })
})
