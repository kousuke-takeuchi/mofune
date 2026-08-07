// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from '../../src/stores/session'
import { provisionGroup, writeObjects, INITIAL_GENERATION } from '../../src/group/provision'
import { decodeConnectionCode, encodeConnectionCode } from '../../src/group/connection-code'
import type { ConnectionCode } from '../../src/group/connection-code'
import { writeStorageSettings } from '../../src/group/storage-credentials'
import { keyId } from '../../src/crypto/keyring'
import { STAFF_SCOPE } from '../../src/crypto/roster'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { registryDb } from '../../src/db/groups'
import { login } from '../../src/group/session'

const ROOT = 'https://public.invalid'

const settings = {
  provider: 's3' as const,
  endpoint: 'https://s3.invalid',
  region: 'auto',
  bucket: 'mofune',
  publicBaseUrl: ROOT,
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
}

async function buildGroup(options: { withSettings: boolean }): Promise<{
  code: ConnectionCode
  storage: MemoryStorageProvider
}> {
  const result = await provisionGroup({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    provider: 's3',
    root: ROOT,
    kdf: TEST_KDF,
    subgroups: [],
    members: [
      {
        loginId: 'watanabe',
        displayName: '渡辺 けい',
        role: 'admin',
        scopes: [],
        password: 'admin-pass',
        email: '',
      },
      {
        loginId: 'sato',
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: [],
        password: 'member-pass',
        email: '',
      },
    ],
  })
  const storage = new MemoryStorageProvider()
  await writeObjects(storage, result.objects)
  const code = decodeConnectionCode(encodeConnectionCode(result.code))

  if (options.withSettings) {
    const session = await login({ code, loginId: 'watanabe', password: 'admin-pass', storage })
    const staffKey = session.groupKeys.get(keyId(STAFF_SCOPE, INITIAL_GENERATION)) as CryptoKey
    await writeStorageSettings({
      storage,
      groupId: 'midori',
      settings,
      staffKey,
      generation: INITIAL_GENERATION,
    })
  }
  return { code, storage }
}

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

describe('the writer a session exposes', () => {
  it('is not the read-only provider participants use', async () => {
    // ここが本丸。公開読みのプロバイダへ書こうとして「オフラインです」と
    // 言い続けるのが、実機で投稿できなかった原因だった。
    const { code, storage } = await buildGroup({ withSettings: true })
    routeFetchTo(storage)
    const session = useSessionStore()
    await session.signIn(code, 'watanabe', 'admin-pass')
    expect(session.writer).not.toBeNull()
    expect(session.writer).not.toBe(session.storage)
    expect(session.writer?.capabilities.write).toBe(true)
  })

  it('is absent for a participant, who has no credentials', async () => {
    const { code, storage } = await buildGroup({ withSettings: true })
    routeFetchTo(storage)
    const session = useSessionStore()
    await session.signIn(code, 'sato', 'member-pass')
    expect(session.writer).toBeNull()
  })

  it('is absent when the group has no stored credentials yet', async () => {
    const { code, storage } = await buildGroup({ withSettings: false })
    routeFetchTo(storage)
    const session = useSessionStore()
    await session.signIn(code, 'watanabe', 'admin-pass')
    expect(session.writer).toBeNull()
  })

  it('is dropped on sign out', async () => {
    const { code, storage } = await buildGroup({ withSettings: true })
    routeFetchTo(storage)
    const session = useSessionStore()
    await session.signIn(code, 'watanabe', 'admin-pass')
    session.signOut()
    expect(session.writer).toBeNull()
  })
})
