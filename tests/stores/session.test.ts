// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from '../../src/stores/session'
import { useGroupsStore } from '../../src/stores/groups'
import { provisionGroup, writeObjects } from '../../src/group/provision'
import { decodeConnectionCode, encodeConnectionCode } from '../../src/group/connection-code'
import type { ConnectionCode } from '../../src/group/connection-code'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { registryDb } from '../../src/db/groups'

const ROOT = 'https://public.invalid'

async function buildGroup(): Promise<{ code: ConnectionCode; storage: MemoryStorageProvider }> {
  const result = await provisionGroup({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    provider: 's3',
    root: ROOT,
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
  return { code: decodeConnectionCode(encodeConnectionCode(result.code)), storage }
}

/** 参加者と同じく、資格情報なしの GET でしか読めない状態を作る。 */
function routeFetchTo(storage: MemoryStorageProvider): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.startsWith(`${ROOT}/`)) return new Response(null, { status: 404 })
      try {
        return new Response(await storage.get(url.slice(ROOT.length + 1)))
      } catch {
        return new Response(null, { status: 404 })
      }
    }),
  )
}

beforeEach(async () => {
  setActivePinia(createPinia())
  await registryDb.groups.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useSessionStore', () => {
  it('starts signed out', () => {
    expect(useSessionStore().isSignedIn).toBe(false)
  })

  it('signs in and exposes the group', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    const session = useSessionStore()
    await session.signIn(code, 'watanabe@example.invalid', 'admin-pass')
    expect(session.isSignedIn).toBe(true)
    expect(session.groupId).toBe('midori')
    expect(session.role).toBe('admin')
  })

  it('remembers the group on the device so it can be unlocked later', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    await useSessionStore().signIn(code, 'watanabe@example.invalid', 'admin-pass')
    const groups = useGroupsStore()
    await groups.load()
    expect(groups.groups.map((group) => group.groupId)).toEqual(['midori'])
    expect(groups.lastGroupId).toBe('midori')
  })

  it('unlocks with the password alone once the group is remembered', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    await useSessionStore().signIn(code, 'watanabe@example.invalid', 'admin-pass')

    // リロード相当。ストアを作り直すとセッションは消える。
    setActivePinia(createPinia())
    const revived = useSessionStore()
    expect(revived.isSignedIn).toBe(false)

    await revived.unlock('midori', 'admin-pass')
    expect(revived.isSignedIn).toBe(true)
    expect(revived.groupId).toBe('midori')
  })

  it('refuses to unlock with the wrong password', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    await useSessionStore().signIn(code, 'watanabe@example.invalid', 'admin-pass')

    setActivePinia(createPinia())
    await expect(useSessionStore().unlock('midori', 'wrong')).rejects.toThrow()
  })

  it('refuses to unlock a group the device does not know', async () => {
    await expect(useSessionStore().unlock('unknown', 'admin-pass')).rejects.toThrow()
  })

  it('drops everything on sign out', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    const session = useSessionStore()
    await session.signIn(code, 'watanabe@example.invalid', 'admin-pass')
    session.signOut()
    expect(session.isSignedIn).toBe(false)
    expect(session.storage).toBeNull()
  })

  it('treats non-members as having a confirmed email', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    const session = useSessionStore()
    await session.signIn(code, 'watanabe@example.invalid', 'admin-pass')
    expect(session.emailConfirmed).toBe(true)
  })
})

describe('useGroupsStore', () => {
  it('has no group before anyone signs in', async () => {
    const groups = useGroupsStore()
    await groups.load()
    expect(groups.lastGroupId).toBeNull()
  })

  it('forgets a group on request', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    await useSessionStore().signIn(code, 'watanabe@example.invalid', 'admin-pass')
    const groups = useGroupsStore()
    await groups.load()
    await groups.forget('midori')
    expect(groups.groups).toHaveLength(0)
  })
})
