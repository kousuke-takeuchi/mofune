import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { RecoveryError, restoreFromRecoveryKit } from '../../src/group/recovery'
import { buildRecoveryKit } from '../../src/group/recovery-kit'
import { provisionGroup, writeObjects, INITIAL_GENERATION } from '../../src/group/provision'
import { decodeConnectionCode, encodeConnectionCode } from '../../src/group/connection-code'
import type { ConnectionCode } from '../../src/group/connection-code'
import { login } from '../../src/group/session'
import { writeStorageSettings } from '../../src/group/storage-credentials'
import { keyId } from '../../src/crypto/keyring'
import { STAFF_SCOPE } from '../../src/crypto/roster'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { registryDb } from '../../src/db/groups'
import { parseKeystoreFile, unlockKeystore } from '../../src/crypto/keystore'
import { keystorePath } from '../../src/storage/paths'

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
  /** 紙に印刷された復元コード。 */
  paper: string
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

  // 紙は開設のときに刷られる。ここでは同じ材料から作り直す
  const contents = await unlockKeystore(
    parseKeystoreFile(await storage.get(await keystorePath('midori', 'watanabe@example.invalid'))),
    'admin-pass',
    code.pepper,
  )
  const kit = await buildRecoveryKit({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    contents,
  })
  return { storage, code, paper: kit.code }
}

beforeEach(async () => {
  await registryDb.groups.clear()
})

describe('restoreFromRecoveryKit', () => {
  it('lets the administrator set a new password and log in again', async () => {
    const { storage, code, paper } = await world()

    await restoreFromRecoveryKit({
      storage,
      code,
      text: paper,
      email: 'watanabe@example.invalid',
      password: 'brand-new-pass',
      kdf: TEST_KDF,
      createWriter: () => storage,
    })

    const session = await login({
      code,
      email: 'watanabe@example.invalid',
      password: 'brand-new-pass',
      storage,
    })
    expect(session.role).toBe('admin')
    // 紙から戻した鍵で、いままでのグループ鍵がそのまま開けること
    expect(session.groupKeys.has(keyId(STAFF_SCOPE, INITIAL_GENERATION))).toBe(true)
  })

  it('can move the administrator to a different address', async () => {
    const { storage, code, paper } = await world()

    await restoreFromRecoveryKit({
      storage,
      code,
      text: paper,
      email: 'Kei.Watanabe@Example.invalid',
      password: 'brand-new-pass',
      kdf: TEST_KDF,
      createWriter: () => storage,
    })

    // 大文字や前後の空白は正規化して同じ置き場所になる
    const session = await login({
      code,
      email: ' kei.watanabe@example.invalid ',
      password: 'brand-new-pass',
      storage,
    })
    expect(session.displayName).toBe('渡辺 けい')
  })

  it('refuses a kit that belongs to another group', async () => {
    const { storage, code } = await world()
    const other = await world()

    await expect(
      restoreFromRecoveryKit({
        storage,
        code,
        text: other.paper,
        email: 'watanabe@example.invalid',
        password: 'brand-new-pass',
        kdf: TEST_KDF,
        createWriter: () => storage,
      }),
    ).rejects.toThrow(RecoveryError)
  })

  it('refuses a code that was mistyped', async () => {
    const { storage, code, paper } = await world()
    const at = Math.floor(paper.length / 2)
    const wrong = paper[at] === 'A' ? 'B' : 'A'
    const broken = `${paper.slice(0, at)}${wrong}${paper.slice(at + 1)}`

    await expect(
      restoreFromRecoveryKit({
        storage,
        code,
        text: broken,
        email: 'watanabe@example.invalid',
        password: 'brand-new-pass',
        kdf: TEST_KDF,
        createWriter: () => storage,
      }),
    ).rejects.toThrow(RecoveryError)
  })

  it('refuses an address that is not an address', async () => {
    const { storage, code, paper } = await world()

    await expect(
      restoreFromRecoveryKit({
        storage,
        code,
        text: paper,
        email: 'watanabe',
        password: 'brand-new-pass',
        kdf: TEST_KDF,
        createWriter: () => storage,
      }),
    ).rejects.toThrow(RecoveryError)
  })
})
