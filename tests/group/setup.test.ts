import { describe, it, expect, afterEach, vi } from 'vitest'
import { SetupError, setUpGroup } from '../../src/group/setup'
import type { SetupOptions } from '../../src/group/setup'
import { parseRecoveryKit } from '../../src/group/recovery-kit'
import { readGroupSettings } from '../../src/group/group-settings'
import { readStorageSettings } from '../../src/group/storage-credentials'
import { decodeConnectionCode } from '../../src/group/connection-code'
import { login } from '../../src/group/session'
import { readGrant } from '../../src/inbox/grants'
import { parseRosterFile, verifyRoster } from '../../src/crypto/roster'
import { rosterPath } from '../../src/storage/paths'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { fromBase64 } from '../../src/crypto/bytes'
import type { StorageProvider } from '../../src/storage/provider'

const settings = {
  provider: 's3' as const,
  endpoint: 'https://example.invalid',
  region: 'auto',
  bucket: 'mofune',
  publicBaseUrl: 'https://pub-1234.r2.dev',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
}

/** 公開読みの経路を、資格情報を持たない参加者の視点で真似る。 */
function servePublicly(storage: StorageProvider): void {
  const base = settings.publicBaseUrl
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.startsWith(`${base}/`)) return new Response(null, { status: 404 })
      try {
        return new Response(await storage.get(url.slice(base.length + 1)))
      } catch {
        return new Response(null, { status: 404 })
      }
    }),
  )
}

function options(storage: StorageProvider, extra: Partial<SetupOptions> = {}): SetupOptions {
  servePublicly(storage)
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    adminLoginId: 'watanabe',
    adminDisplayName: '渡辺 けい',
    adminPassword: 'admin-pass',
    adminEmail: 'watanabe@example.invalid',
    settings,
    kdf: TEST_KDF,
    storage,
    ...extra,
  } as SetupOptions
}

function failingPut(): StorageProvider {
  const inner = new MemoryStorageProvider()
  return {
    capabilities: inner.capabilities,
    put: () => Promise.reject(new Error('denied')),
    get: (path: string) => inner.get(path),
    delete: (path: string) => inner.delete(path),
    list: (prefix: string, after?: string) => inner.list(prefix, after),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setUpGroup', () => {
  it('reports every connection check step', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    expect(result.check.ok).toBe(true)
    expect(result.check.steps.map((step) => step.name)).toEqual([
      'write',
      'read',
      'public',
      'delete',
    ])
  })

  it('refuses to provision when participants cannot read without credentials', async () => {
    const storage = new MemoryStorageProvider()
    const setup = options(storage)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    await expect(setUpGroup(setup)).rejects.toThrow(/公開URL/)
    expect(await storage.list('midori/')).toHaveLength(0)
  })

  it('writes the roster, and it verifies against the connection code', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    const file = parseRosterFile(await storage.get(rosterPath('midori')))
    await expect(
      verifyRoster(file, fromBase64(result.code.adminPublicKey)),
    ).resolves.toBeDefined()
  })

  it('lets the admin log in with the code it produced', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    const session = await login({
      code: decodeConnectionCode(result.connectionCode),
      loginId: 'watanabe',
      password: 'admin-pass',
      storage,
    })
    expect(session.role).toBe('admin')
    expect(session.groupName).toBe('みどり台グループ')
  })

  it('stores the write credentials under the staff scope', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    const session = await login({
      code: decodeConnectionCode(result.connectionCode),
      loginId: 'watanabe',
      password: 'admin-pass',
      storage,
    })
    const stored = await readStorageSettings({
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
    })
    expect(stored.bucket).toBe('mofune')
  })

  it('writes the default group settings', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    const session = await login({
      code: decodeConnectionCode(result.connectionCode),
      loginId: 'watanabe',
      password: 'admin-pass',
      storage,
    })
    const staffKey = session.groupKeys.get('staff:v1') as CryptoKey
    const stored = await readGroupSettings({ storage, groupId: 'midori', staffKey })
    expect(stored.absenceReasons.length).toBeGreaterThan(0)
  })

  it('returns a recovery kit that restores the admin root key', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    const restored = await parseRecoveryKit(result.recoveryKit.code)
    expect(restored.groupId).toBe('midori')
    expect(restored.contents.ecdsa.privateKey.length).toBeGreaterThan(0)
  })

  it('issues upload grants for members', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(
      options(storage, {
        members: [
          {
            loginId: 'sato',
            displayName: '佐藤 さくら',
            role: 'member',
            scopes: [],
            password: 'member-pass',
            email: '',
          },
        ],
      }),
    )
    expect(result.grantsIssued).toHaveLength(1)
    expect((await storage.list('midori/inbox/')).length).toBeGreaterThan(0)
  })

  it('issues no grants when the group has no members yet', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    expect(result.grantsIssued).toEqual([])
  })

  it('does not write anything when the connection check fails', async () => {
    const storage = failingPut()
    await expect(setUpGroup(options(storage))).rejects.toThrow(SetupError)
    expect(await storage.list('midori/')).toHaveLength(0)
  })

  it('says which step of the connection check failed', async () => {
    const storage = failingPut()
    await expect(setUpGroup(options(storage))).rejects.toThrow(/書き込めません/)
  })

  it('carries the whole connection check on the error', async () => {
    // どの段まで通ってどこで落ちたかを画面に出せないと、直しようがない。
    const inner = new MemoryStorageProvider()
    const storage: StorageProvider = {
      capabilities: inner.capabilities,
      put: (path, data) => inner.put(path, data),
      get: (path) => inner.get(path),
      delete: () => Promise.reject(new TypeError('Failed to fetch')),
      list: (prefix, after) => inner.list(prefix, after),
    }
    const setup = options(storage)
    const error = await setUpGroup(setup).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(SetupError)
    expect((error as SetupError).check?.steps.map((step) => step.name)).toEqual([
      'write',
      'read',
      'public',
      'delete',
    ])
  })

  it('points the connection code at the public read url', async () => {
    // 参加者は資格情報を持たず、root へ素の GET で読む。S3 の API エンドポイントを
    // 入れてしまうと全員 401 になり、紙を配り直すまで直せない。
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    expect(result.code.root).toBe('https://pub-1234.r2.dev')
  })

  it('produces a connection code that decodes back', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    const decoded = decodeConnectionCode(result.connectionCode)
    expect(decoded.groupId).toBe('midori')
    expect(decoded.pepper.length).toBeGreaterThan(0)
  })

  it('issues grants the member can actually decrypt', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(
      options(storage, {
        members: [
          {
            loginId: 'sato',
            displayName: '佐藤 さくら',
            role: 'member',
            scopes: [],
            password: 'member-pass',
            email: '',
          },
        ],
      }),
    )
    const session = await login({
      code: decodeConnectionCode(result.connectionCode),
      loginId: 'sato',
      password: 'member-pass',
      storage,
    })
    const grant = await readGrant({
      storage,
      groupId: 'midori',
      userId: session.userId,
      ecdhPrivate: session.ecdhPrivate,
    })
    expect(grant.slots.length).toBeGreaterThan(0)
  })

  it('creates the subgroups it was given', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(
      options(storage, { subgroups: [{ id: 'sg_a', name: 'Aチーム', parent: null }] }),
    )
    const file = parseRosterFile(await storage.get(rosterPath('midori')))
    const roster = await verifyRoster(file, fromBase64(result.code.adminPublicKey))
    expect(roster.subgroups.map((s) => s.id)).toEqual(['sg_a'])
  })
})
