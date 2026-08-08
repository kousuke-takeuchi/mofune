import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { BulkMoveError, moveEveryone } from '../../src/group/bulk-move'
import { addMember } from '../../src/group/membership'
import { createSubgroup, setMemberScopes } from '../../src/group/subgroups'
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

async function admin(storage: MemoryStorageProvider, code: ConnectionCode): Promise<Session> {
  return login({ code, email: 'watanabe@example.invalid', password: 'admin-pass', storage })
}

interface World {
  storage: MemoryStorageProvider
  code: ConnectionCode
  from: string
  to: string
  sato: string
  mori: string
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
  let session = await admin(storage, code)
  await writeStorageSettings({
    storage,
    groupId: 'midori',
    settings,
    staffKey: session.groupKeys.get(keyId(STAFF_SCOPE, INITIAL_GENERATION)) as CryptoKey,
    generation: INITIAL_GENERATION,
  })

  const from = (await createSubgroup({ storage, session, code, name: 'ひよこ組', parent: null })).id
  session = await admin(storage, code)
  const to = (await createSubgroup({ storage, session, code, name: 'ぱんだ組', parent: null })).id

  session = await admin(storage, code)
  const { userId: sato } = await addMember({
    storage,
    session,
    code,
    settings,
    kdf: TEST_KDF,
    member: {
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: [from],
      password: 'sato-pass',
      email: 'sato@example.invalid',
    },
  })
  session = await admin(storage, code)
  const { userId: mori } = await addMember({
    storage,
    session,
    code,
    settings,
    kdf: TEST_KDF,
    member: {
      displayName: '森 ゆい',
      role: 'member',
      scopes: [from],
      password: 'mori-pass',
      email: 'mori@example.invalid',
    },
  })

  return { storage, code, from, to, sato, mori }
}

beforeEach(async () => {
  await registryDb.groups.clear()
})

describe('moveEveryone', () => {
  it('moves every member of one subgroup into another', async () => {
    const { storage, code, from, to, sato, mori } = await world()
    const session = await admin(storage, code)
    const result = await moveEveryone({ storage, session, code, settings, from, to })

    expect(result.moved.sort()).toEqual([mori, sato].sort())

    const roster = await verifyRoster(
      await loadRosterFile({ storage, groupId: 'midori' }),
      fromBase64(code.adminPublicKey),
    )
    for (const userId of [sato, mori]) {
      const member = roster.members.find((candidate) => candidate.userId === userId)
      expect(member?.scopes).toContain(to)
      expect(member?.scopes).not.toContain(from)
    }
  })

  it('gives the moved members the key of where they landed', async () => {
    const { storage, code, from, to } = await world()
    const session = await admin(storage, code)
    await moveEveryone({ storage, session, code, settings, from, to })

    const sato = await login({
      code,
      email: 'sato@example.invalid',
      password: 'sato-pass',
      storage,
    })
    expect(sato.groupKeys.has(keyId(to, sato.generation))).toBe(true)
  })

  it('leaves people who were somewhere else alone', async () => {
    const { storage, code, from, to, sato } = await world()
    let session = await admin(storage, code)
    // 佐藤さんだけ別の組へ先に移す
    const other = (await createSubgroup({ storage, session, code, name: 'りす組', parent: null })).id
    session = await admin(storage, code)
    await setMemberScopes({ storage, session, code, settings, userId: sato, scopes: [other] })

    session = await admin(storage, code)
    const result = await moveEveryone({ storage, session, code, settings, from, to })
    expect(result.moved).not.toContain(sato)
  })

  it('refuses when the destination does not exist', async () => {
    const { storage, code, from } = await world()
    const session = await admin(storage, code)
    await expect(
      moveEveryone({ storage, session, code, settings, from, to: 'sg_missing' }),
    ).rejects.toThrow(BulkMoveError)
  })

  it('refuses to move a subgroup into itself', async () => {
    const { storage, code, from } = await world()
    const session = await admin(storage, code)
    await expect(
      moveEveryone({ storage, session, code, settings, from, to: from }),
    ).rejects.toThrow(BulkMoveError)
  })

  it('refuses anyone but an admin', async () => {
    const { storage, code, from, to } = await world()
    const session = await admin(storage, code)
    const staff = { ...session, role: 'staff' } as Session
    await expect(
      moveEveryone({ storage, session: staff, code, settings, from, to }),
    ).rejects.toThrow(BulkMoveError)
  })
})
