import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  PasswordChangeError,
  buildPasswordChange,
  parsePasswordChange,
  applyPasswordChange,
} from '../../src/group/password-change'
import { provisionGroup, writeObjects, INITIAL_GENERATION } from '../../src/group/provision'
import { decodeConnectionCode, encodeConnectionCode } from '../../src/group/connection-code'
import { login } from '../../src/group/session'
import { writeStorageSettings } from '../../src/group/storage-credentials'
import { keyId } from '../../src/crypto/keyring'
import { STAFF_SCOPE } from '../../src/crypto/roster'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { registryDb } from '../../src/db/groups'
import { keystorePath } from '../../src/storage/paths'
import { utf8 } from '../../src/crypto/bytes'

const settings = {
  provider: 's3' as const,
  endpoint: 'https://s3.invalid',
  region: 'auto',
  bucket: 'mofune',
  publicBaseUrl: 'https://public.invalid',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
}

async function world() {
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
      {
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: [],
        password: 'first-pass',
        email: 'sato@example.invalid',
      },
    ],
  })
  const storage = new MemoryStorageProvider()
  await writeObjects(storage, result.objects)
  const code = decodeConnectionCode(encodeConnectionCode(result.code))
  const admin = await login({
    code,
    email: 'watanabe@example.invalid',
    password: 'admin-pass',
    storage,
  })
  await writeStorageSettings({
    storage,
    groupId: 'midori',
    settings,
    staffKey: admin.groupKeys.get(keyId(STAFF_SCOPE, INITIAL_GENERATION)) as CryptoKey,
    generation: INITIAL_GENERATION,
  })
  const member = await login({
    code,
    email: 'sato@example.invalid',
    password: 'first-pass',
    storage,
  })
  return { storage, code, admin, member }
}

beforeEach(async () => {
  await registryDb.groups.clear()
})

describe('buildPasswordChange', () => {
  it('re-seals the same keys under the new password', async () => {
    const { code, member } = await world()

    const change = await buildPasswordChange({
      session: member,
      email: 'sato@example.invalid',
      newPassword: 'my-own-pass',
      pepper: code.pepper,
      kdf: TEST_KDF,
    })

    expect(change.userId).toBe(member.userId)
    // 新しい鍵を作らない。作ると過去のお知らせが読めなくなる
    expect(change.keystore.includes('"envelope"')).toBe(true)
  })

  it('refuses a password that is too short to be worth changing to', async () => {
    const { code, member } = await world()
    await expect(
      buildPasswordChange({
        session: member,
        email: 'sato@example.invalid',
        newPassword: 'short',
        pepper: code.pepper,
        kdf: TEST_KDF,
      }),
    ).rejects.toThrow(PasswordChangeError)
  })
})

describe('parsePasswordChange', () => {
  it('reads what it built', async () => {
    const { code, member } = await world()
    const change = await buildPasswordChange({
      session: member,
      email: 'sato@example.invalid',
      newPassword: 'my-own-pass',
      pepper: code.pepper,
      kdf: TEST_KDF,
    })
    expect(parsePasswordChange(utf8(JSON.stringify(change)))).toEqual(change)
  })

  it('refuses something that is not one', () => {
    expect(() => parsePasswordChange(utf8('{"hello":"world"}'))).toThrow(PasswordChangeError)
  })
})

describe('applyPasswordChange', () => {
  it('lets the member in with the new password, keeping the old keys', async () => {
    const { storage, code, member } = await world()
    const change = await buildPasswordChange({
      session: member,
      email: 'sato@example.invalid',
      newPassword: 'my-own-pass',
      pepper: code.pepper,
      kdf: TEST_KDF,
    })

    await applyPasswordChange({ storage, groupId: 'midori', change, userId: member.userId })

    const after = await login({
      code,
      email: 'sato@example.invalid',
      password: 'my-own-pass',
      storage,
    })
    expect(after.userId).toBe(member.userId)
    expect(after.displayName).toBe('佐藤 さくら')
    // 同じ鍵なので、古いお知らせもそのまま読める
    expect([...after.groupKeys.keys()]).toEqual([...member.groupKeys.keys()])
  })

  it('closes the old password', async () => {
    const { storage, code, member } = await world()
    const change = await buildPasswordChange({
      session: member,
      email: 'sato@example.invalid',
      newPassword: 'my-own-pass',
      pepper: code.pepper,
      kdf: TEST_KDF,
    })
    await applyPasswordChange({ storage, groupId: 'midori', change, userId: member.userId })

    await expect(
      login({ code, email: 'sato@example.invalid', password: 'first-pass', storage }),
    ).rejects.toThrow()
  })

  it('refuses a change that claims to be someone else', async () => {
    const { storage, code, member } = await world()
    const change = await buildPasswordChange({
      session: member,
      email: 'sato@example.invalid',
      newPassword: 'my-own-pass',
      pepper: code.pepper,
      kdf: TEST_KDF,
    })

    // 受信箱の置き場所は本人ぶんしかないので、名乗りと一致しなければ弾く
    await expect(
      applyPasswordChange({ storage, groupId: 'midori', change, userId: 'u_someone_else' }),
    ).rejects.toThrow(PasswordChangeError)

    // 元のパスワードのまま入れる
    const still = await login({
      code,
      email: 'sato@example.invalid',
      password: 'first-pass',
      storage,
    })
    expect(still.userId).toBe(member.userId)
  })

  it('writes it where the login will look for it', async () => {
    const { storage, code, member } = await world()
    const change = await buildPasswordChange({
      session: member,
      email: 'sato@example.invalid',
      newPassword: 'my-own-pass',
      pepper: code.pepper,
      kdf: TEST_KDF,
    })
    await applyPasswordChange({ storage, groupId: 'midori', change, userId: member.userId })
    await expect(
      storage.get(await keystorePath('midori', 'sato@example.invalid')),
    ).resolves.toBeDefined()
  })
})
