import type { Bytes } from '../../src/crypto/bytes'
import { describe, it, expect, beforeAll } from 'vitest'
import { LoginError, login } from '../../src/group/session'
import { provisionGroup, writeObjects } from '../../src/group/provision'
import type { ProvisionResult } from '../../src/group/provision'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { manifestPath, rosterPath } from '../../src/storage/paths'
import { exportAesKey } from '../../src/crypto/symmetric'
import { utf8 } from '../../src/crypto/bytes'

let provisioned: ProvisionResult
let storage: MemoryStorageProvider

beforeAll(async () => {
  provisioned = await provisionGroup({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    provider: 'http',
    root: 'https://example.invalid/mofune',
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
      {
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: ['sg_a'],
        password: 'member-pass',
        email: 'sato@example.invalid',
      },
    ],
  })
  storage = new MemoryStorageProvider()
  await writeObjects(storage, provisioned.objects)
})

describe('login', () => {
  it('logs a member in and returns their scoped group keys', async () => {
    const session = await login({
      code: provisioned.code,
      email: 'sato@example.invalid',
      password: 'member-pass',
      storage,
    })
    expect(session.displayName).toBe('佐藤 さくら')
    expect(session.role).toBe('member')
    expect(session.groupName).toBe('みどり台グループ')
    expect([...session.groupKeys.keys()].sort()).toEqual(['all:v1', 'sg_a:v1'])
    expect(await exportAesKey(session.groupKeys.get('all:v1') as CryptoKey)).toHaveLength(32)
  })

  it('accepts an address typed with different case and surrounding spaces', async () => {
    const session = await login({
      code: provisioned.code,
      email: '  SATO@Example.invalid  ',
      password: 'member-pass',
      storage,
    })
    expect(session.displayName).toBe('佐藤 さくら')
  })

  it('gives the admin the staff key as well', async () => {
    const session = await login({
      code: provisioned.code,
      email: 'watanabe@example.invalid',
      password: 'admin-pass',
      storage,
    })
    expect(session.role).toBe('admin')
    expect(session.groupKeys.has('staff:v1')).toBe(true)
  })

  it('rejects a wrong password', async () => {
    await expect(
      login({ code: provisioned.code, email: 'sato@example.invalid', password: 'wrong', storage }),
    ).rejects.toThrow(LoginError)
  })

  it('reports an unknown login id with the same message as a wrong password', async () => {
    const unknown = (await login({
      code: provisioned.code,
      email: 'nobody@example.invalid',
      password: 'member-pass',
      storage,
    }).catch((error: unknown) => error)) as Error
    const wrongPassword = (await login({
      code: provisioned.code,
      email: 'sato@example.invalid',
      password: 'wrong',
      storage,
    }).catch((error: unknown) => error)) as Error
    expect(unknown.message).toBe(wrongPassword.message)
  })

  it('refuses a roster signed by a key other than the one in the connection code', async () => {
    const foreign = await provisionGroup({
      groupId: 'midori',
      groupName: 'にせグループ',
      provider: 'http',
      root: 'https://example.invalid/mofune',
      kdf: TEST_KDF,
      subgroups: [],
      members: [
        {
          displayName: '偽管理者',
          role: 'admin',
          scopes: [],
          password: 'admin-pass',
          email: 'x@example.invalid',
        },
      ],
    })
    const tampered = new MemoryStorageProvider()
    await writeObjects(tampered, provisioned.objects)
    await tampered.put(
      rosterPath('midori'),
      foreign.objects.get(rosterPath('midori')) as Bytes,
    )
    await expect(
      login({ code: provisioned.code, email: 'sato@example.invalid', password: 'member-pass', storage: tampered }),
    ).rejects.toThrow(LoginError)
  })

  it('refuses a manifest whose group id does not match the connection code', async () => {
    const mismatched = new MemoryStorageProvider()
    await writeObjects(mismatched, provisioned.objects)
    await mismatched.put(
      manifestPath('midori'),
      utf8(
        JSON.stringify({
          v: 1,
          groupId: 'other',
          groupName: 'x',
          keyringGeneration: 1,
          rosterGeneration: 1,
          functionUrl: null,
          notificationChannels: [],
        }),
      ),
    )
    await expect(
      login({
        code: provisioned.code,
        email: 'sato@example.invalid',
        password: 'member-pass',
        storage: mismatched,
      }),
    ).rejects.toThrow(/group/)
  })

  it('does not expose the password anywhere on the session', async () => {
    const session = await login({
      code: provisioned.code,
      email: 'sato@example.invalid',
      password: 'member-pass',
      storage,
    })
    expect(JSON.stringify(Object.keys(session))).not.toContain('password')
  })
})
