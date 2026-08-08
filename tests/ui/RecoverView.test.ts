// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import RecoverView from '../../src/ui/RecoverView.vue'
import { provisionGroup, writeObjects, INITIAL_GENERATION } from '../../src/group/provision'
import { encodeConnectionCode, decodeConnectionCode } from '../../src/group/connection-code'
import { login } from '../../src/group/session'
import { writeStorageSettings } from '../../src/group/storage-credentials'
import { buildRecoveryKit } from '../../src/group/recovery-kit'
import { parseKeystoreFile, unlockKeystore } from '../../src/crypto/keystore'
import { keystorePath } from '../../src/storage/paths'
import { keyId } from '../../src/crypto/keyring'
import { STAFF_SCOPE } from '../../src/crypto/roster'
import { TEST_KDF } from '../../src/crypto/kdf'
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
    ],
  })
  const storage = new MemoryStorageProvider()
  await writeObjects(storage, result.objects)
  const connectionCode = encodeConnectionCode(result.code)
  const code = decodeConnectionCode(connectionCode)

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
  return { storage, connectionCode, code, paper: kit.code }
}

/**
 * 書き写しミスを模す。末尾の1文字は捨てられるビットに当たることがあり、
 * 書き換えても同じ鍵に戻るので、真ん中を壊す。
 */
function brokenAt(paper: string): string {
  const at = Math.floor(paper.length / 2)
  const wrong = paper[at] === 'A' ? 'B' : 'A'
  return `${paper.slice(0, at)}${wrong}${paper.slice(at + 1)}`
}

let mounted: VueWrapper[] = []

beforeEach(async () => {
  await registryDb.groups.clear()
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

function mountRecover(storage: MemoryStorageProvider) {
  const wrapper = mount(RecoverView, {
    props: {
      kdf: TEST_KDF,
      createStorage: () => storage,
      createWriter: () => storage,
    },
  })
  mounted.push(wrapper)
  return wrapper
}

async function fill(wrapper: VueWrapper, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    await wrapper.get(`[data-test="${name}"]`).setValue(value)
  }
}

describe('RecoverView', () => {
  it('restores the login and says which group it belongs to', async () => {
    const { storage, connectionCode, paper } = await world()
    const wrapper = mountRecover(storage)

    await fill(wrapper, {
      code: connectionCode,
      paper,
      email: 'watanabe@example.invalid',
      password: 'brand-new-pass',
    })
    await wrapper.get('[data-test="restore"]').trigger('click')
    await vi.waitFor(
      () => {
        if (!wrapper.find('[data-test="done"]').exists()) throw new Error('not done yet')
      },
      { timeout: 4000, interval: 10 },
    )

    expect(wrapper.get('[data-test="done"]').text()).toContain('みどり台グループ')
    // 新しいパスワードで本当に入れること
    const session = await login({
      code: decodeConnectionCode(connectionCode),
      email: 'watanabe@example.invalid',
      password: 'brand-new-pass',
      storage,
    })
    expect(session.role).toBe('admin')
  })

  it('explains a paper that does not match instead of failing silently', async () => {
    const { storage, connectionCode, paper } = await world()
    const wrapper = mountRecover(storage)

    await fill(wrapper, {
      code: connectionCode,
      paper: brokenAt(paper),
      email: 'watanabe@example.invalid',
      password: 'brand-new-pass',
    })
    await wrapper.get('[data-test="restore"]').trigger('click')
    await vi.waitFor(
      () => {
        if (!wrapper.find('[data-test="error"]').exists()) throw new Error('no error yet')
      },
      { timeout: 4000, interval: 10 },
    )
    expect(wrapper.get('[data-test="error"]').text()).toContain('復元コード')
  })

  it('will not start until every field is filled in', async () => {
    const { storage } = await world()
    const wrapper = mountRecover(storage)
    expect(wrapper.get('[data-test="restore"]').attributes('disabled')).toBeDefined()
  })

  it('warns that the paper is the key itself', async () => {
    const { storage } = await world()
    expect(mountRecover(storage).text()).toContain('鍵そのもの')
  })
})

describe('the restore flow does not touch the network on its own', () => {
  it('never calls fetch', async () => {
    const calls = vi.fn()
    vi.stubGlobal('fetch', calls)
    const { storage, connectionCode, paper } = await world()
    const wrapper = mountRecover(storage)

    await fill(wrapper, {
      code: connectionCode,
      paper,
      email: 'watanabe@example.invalid',
      password: 'brand-new-pass',
    })
    await wrapper.get('[data-test="restore"]').trigger('click')
    await flushPromises()
    expect(calls).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
