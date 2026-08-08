import { describe, it, expect } from 'vitest'
import { readProviderFor, writerFor } from '../../src/storage/factory'
import { FunctionStorageProvider } from '../../src/storage/function'
import { HttpStorageProvider } from '../../src/storage/http'
import { S3StorageProvider } from '../../src/storage/s3'
import { WebdavStorageProvider } from '../../src/storage/webdav'
import type { ConnectionCode } from '../../src/group/connection-code'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { keyId } from '../../src/crypto/keyring'
import { STAFF_SCOPE } from '../../src/crypto/roster'
import { writeStorageSettings } from '../../src/group/storage-credentials'
import type { Session } from '../../src/group/session'

function code(overrides: Partial<ConnectionCode> = {}): ConnectionCode {
  return {
    v: 1,
    groupId: 'g_midori',
    provider: 's3',
    root: 'https://public.invalid',
    pepper: 'p',
    adminPublicKey: 'A',
    ...overrides,
  }
}

async function staffSession(): Promise<{ session: Session; staffKey: CryptoKey }> {
  const staffKey = await generateAesKey()
  return {
    staffKey,
    session: {
      groupId: 'g_midori',
      groupName: 'みどり台',
      userId: 'u_tanaka',
      displayName: '田中 みか',
      role: 'staff',
      scopes: ['all', 'staff'],
      groupKeys: new Map([[keyId(STAFF_SCOPE, 1), staffKey]]),
      generation: 1,
      roster: { groupId: 'g_midori', generation: 1, subgroups: [], members: [] },
      ecdhPrivate: new Uint8Array(0),
      ecdsaPrivate: new Uint8Array(0),
    } as unknown as Session,
  }
}

describe('readProviderFor', () => {
  it('reads a public bucket over plain HTTP', () => {
    expect(readProviderFor(code())).toBeInstanceOf(HttpStorageProvider)
  })

  it('goes through the function when the group lives in Drive', () => {
    const provider = readProviderFor(
      code({ provider: 'gdrive', root: 'https://script.google.com/macros/s/AK/exec' }),
    )
    expect(provider).toBeInstanceOf(FunctionStorageProvider)
    // 公開バケットと違い、この経路は一覧が取れる
    expect(provider.capabilities.list).toBe(true)
    expect(provider.capabilities.write).toBe(false)
  })
})

describe('a group that lives on WebDAV', () => {
  it('reads the public share by appending the path', () => {
    const provider = readProviderFor(
      code({ provider: 'webdav', root: 'https://nas.invalid/public.php/dav/files/TOKEN' }),
    )
    expect(provider).toBeInstanceOf(WebdavStorageProvider)
    expect(provider.capabilities.list).toBe(true)
    // presigned URL が無いので、参加者が自分で置く道は無い
    expect(provider.capabilities.inbox).toBe(false)
  })

  it('writes with the basic auth kept in the sealed settings', async () => {
    const { session, staffKey } = await staffSession()
    const storage = new MemoryStorageProvider()
    await writeStorageSettings({
      storage,
      groupId: 'g_midori',
      generation: 1,
      staffKey,
      settings: {
        provider: 'webdav',
        baseUrl: 'https://nas.invalid/remote.php/dav/files/mofune',
        publicBaseUrl: 'https://nas.invalid/public.php/dav/files/TOKEN',
        username: 'mofune',
        password: 'secret',
      },
    })

    const writer = await writerFor({
      code: code({ provider: 'webdav', root: 'https://nas.invalid/public.php/dav/files/TOKEN' }),
      session,
      storage,
    })
    expect(writer).toBeInstanceOf(WebdavStorageProvider)
    expect(writer?.capabilities.write).toBe(true)
  })
})

describe('writerFor', () => {
  it('gives a participant nothing to write with', async () => {
    const { session } = await staffSession()
    const member = { ...session, role: 'member' } as Session
    expect(
      await writerFor({ code: code(), session: member, storage: new MemoryStorageProvider() }),
    ).toBeNull()
  })

  it('builds the S3 writer from the sealed credentials', async () => {
    const { session, staffKey } = await staffSession()
    const storage = new MemoryStorageProvider()
    await writeStorageSettings({
      storage,
      groupId: 'g_midori',
      generation: 1,
      staffKey,
      settings: {
        provider: 's3',
        endpoint: 'https://s3.invalid',
        region: 'auto',
        bucket: 'mofune',
        publicBaseUrl: 'https://public.invalid',
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      },
    })

    expect(await writerFor({ code: code(), session, storage })).toBeInstanceOf(S3StorageProvider)
  })

  it('writes through the function when the group lives in Drive', async () => {
    const { session, staffKey } = await staffSession()
    const storage = new MemoryStorageProvider()
    await writeStorageSettings({
      storage,
      groupId: 'g_midori',
      generation: 1,
      staffKey,
      settings: {
        provider: 'gdrive',
        functionUrl: 'https://script.google.com/macros/s/AK/exec',
        publicBaseUrl: 'https://script.google.com/macros/s/AK/exec',
        token: 'shared-secret',
      },
    })

    const writer = await writerFor({
      code: code({ provider: 'gdrive', root: 'https://script.google.com/macros/s/AK/exec' }),
      session,
      storage,
    })
    expect(writer).toBeInstanceOf(FunctionStorageProvider)
    expect(writer?.capabilities.write).toBe(true)
  })

  it('gives nothing when the group has no storage settings yet', async () => {
    const { session } = await staffSession()
    const storage = new MemoryStorageProvider()

    expect(
      await writerFor({
        code: code({ provider: 'gdrive', root: 'https://script.google.com/macros/s/AK/exec' }),
        session,
        storage,
      }),
    ).toBeNull()
  })
})
