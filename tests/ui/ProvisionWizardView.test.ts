// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import ProvisionWizardView from '../../src/ui/ProvisionWizardView.vue'
import { MemoryStorageProvider } from '../../src/storage/memory'
import type { StorageProvider } from '../../src/storage/provider'
import { TEST_KDF } from '../../src/crypto/kdf'

let mounted: VueWrapper[] = []

/** 実在しないホスト。ここ以外へ fetch したら、それは外部へ出ている。 */
const PUBLIC_BASE = 'https://public.invalid'

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
  vi.unstubAllGlobals()
})

function mountWizard() {
  const storage = new MemoryStorageProvider()
  // 公開読みの確認だけはネットワークを通るので、インメモリへ向ける。
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.startsWith(`${PUBLIC_BASE}/`)) return new Response(null, { status: 404 })
      try {
        return new Response(await storage.get(url.slice(PUBLIC_BASE.length + 1)))
      } catch {
        return new Response(null, { status: 404 })
      }
    }),
  )
  const wrapper = mount(ProvisionWizardView, {
    // 本番の KDF はテストで使わない。プロバイダも差し替えて外部へ出さない。
    props: { kdf: TEST_KDF, createStorage: () => storage },
  })
  mounted.push(wrapper)
  return wrapper
}

async function fillGroupStep(wrapper: VueWrapper) {
  await wrapper.find('[data-test="group-name"]').setValue('みどり台グループ')
  await wrapper.find('[data-test="admin-display-name"]').setValue('渡辺 けい')
  await wrapper.find('[data-test="admin-password"]').setValue('admin-pass-1234')
  await wrapper.find('[data-test="admin-email"]').setValue('watanabe@example.com')
  await wrapper.find('[data-test="next"]').trigger('click')
}

async function fillStorageStep(wrapper: VueWrapper) {
  await wrapper.find('[data-test="endpoint"]').setValue('https://example.invalid')
  await wrapper.find('[data-test="bucket"]').setValue('mofune')
  await wrapper.find('[data-test="public-base-url"]').setValue(PUBLIC_BASE)
  await wrapper.find('[data-test="access-key-id"]').setValue('AKID')
  await wrapper.find('[data-test="secret-access-key"]').setValue('SECRET')
  await wrapper.find('[data-test="next"]').trigger('click')
}

describe('ProvisionWizardView', () => {
  it('starts on the group information step', () => {
    const wrapper = mountWizard()
    expect(wrapper.find('[data-test="step"]').text()).toContain('1')
    expect(wrapper.find('[data-test="group-name"]').exists()).toBe(true)
  })

  it('refuses to move on without the group information', async () => {
    const wrapper = mountWizard()
    await wrapper.find('[data-test="next"]').trigger('click')
    expect(wrapper.find('[data-test="error"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="group-name"]').exists()).toBe(true)
  })

  it('moves to the storage step once the information is filled in', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    expect(wrapper.find('[data-test="endpoint"]').exists()).toBe(true)
  })

  it('says which providers support the member uplink', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    expect(wrapper.text()).toContain('欠席')
  })

  it('runs the connection check on the third step', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="check-result"]').exists()) throw new Error('not checked')
    }, { timeout: 4000, interval: 20 })
    expect(wrapper.findAll('[data-test="check-step"]').length).toBeGreaterThan(0)
  })

  it('shows the recovery kit only after provisioning succeeds', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="recovery-code"]').exists()) throw new Error('not yet')
    }, { timeout: 8000, interval: 20 })
    expect(wrapper.find('[data-test="recovery-code"]').text().length).toBeGreaterThan(0)
  })

  it('shows the connection code to hand out', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="connection-code"]').exists()) throw new Error('not yet')
    }, { timeout: 8000, interval: 20 })
    expect(wrapper.find('[data-test="connection-code"]').text().length).toBeGreaterThan(0)
  })

  it('will not finish until the admin confirms the kit is stored', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="finish"]').exists()) throw new Error('not yet')
    }, { timeout: 8000, interval: 20 })
    await wrapper.find('[data-test="finish"]').trigger('click')
    expect(wrapper.emitted('done')).toBeFalsy()

    await wrapper.find('[data-test="kit-stored"]').setValue(true)
    await wrapper.find('[data-test="finish"]').trigger('click')
    expect(wrapper.emitted('done')).toBeTruthy()
  })

  it('warns that the kit and the code cannot be shown again', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="recovery-code"]').exists()) throw new Error('not yet')
    }, { timeout: 8000, interval: 20 })
    expect(wrapper.text()).toContain('二度と')
  })

  it('shows every check step when provisioning stops partway', async () => {
    // 「write: NG — 消せません」のように、落ちた段と文言がずれると原因を追えない。
    const inner = new MemoryStorageProvider()
    const failsToDelete: StorageProvider = {
      capabilities: inner.capabilities,
      put: (path, data) => inner.put(path, data),
      get: (path) => inner.get(path),
      delete: () => Promise.reject(new TypeError('Failed to fetch')),
      list: (prefix, after) => inner.list(prefix, after),
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith(`${PUBLIC_BASE}/`)
          ? new Response(await inner.get(url.slice(PUBLIC_BASE.length + 1)))
          : new Response(null, { status: 404 }),
      ),
    )
    const wrapper = mount(ProvisionWizardView, {
      props: { kdf: TEST_KDF, createStorage: () => failsToDelete },
    })
    mounted.push(wrapper)

    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="check-result"]').exists()) throw new Error('not yet')
    }, { timeout: 8000, interval: 20 })

    const steps = wrapper.findAll('[data-test="check-step"]').map((step) => step.text())
    expect(steps).toHaveLength(4)
    expect(steps[3]).toContain('delete')
    expect(steps[3]).toContain('NG')
    expect(steps[0]).toContain('OK')
  })

  it('emits cancel from the first step', async () => {
    const wrapper = mountWizard()
    await wrapper.find('[data-test="cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toBeTruthy()
  })

  it('does not reach any host but the storage it was given', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="connection-code"]').exists()) throw new Error('not yet')
    }, { timeout: 8000, interval: 20 })
    const calls = vi.mocked(fetch).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const [url] of calls) {
      expect(String(url).startsWith(PUBLIC_BASE)).toBe(true)
    }
  })

  it('asks for the public read url, and hands it out as the connection code root', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="connection-code"]').exists()) throw new Error('not yet')
    }, { timeout: 8000, interval: 20 })
    const { decodeConnectionCode } = await import('../../src/group/connection-code')
    const code = decodeConnectionCode(wrapper.find('[data-test="connection-code"]').text())
    expect(code.root).toBe(PUBLIC_BASE)
  })

  it('refuses to provision without the public read url', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await wrapper.find('[data-test="endpoint"]').setValue('https://example.invalid')
    await wrapper.find('[data-test="bucket"]').setValue('mofune')
    await wrapper.find('[data-test="access-key-id"]').setValue('AKID')
    await wrapper.find('[data-test="secret-access-key"]').setValue('SECRET')
    await wrapper.find('[data-test="next"]').trigger('click')
    expect(wrapper.find('[data-test="error"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="public-base-url"]').exists()).toBe(true)
  })
})

const DAV_PUBLIC = 'https://nas.invalid/public.php/dav/files/TOKEN'

/**
 * 置き場の段まで進めた状態で返す。
 *
 * 公開読みの確認は本番の経路 (関数経由 / WebDAV の公開共有) を通るので、
 * その2つだけをインメモリへ向ける。プロバイダごと差し替えてしまうと、
 * 経路の組み立てを検査できない。
 */
async function atStorageStep(overrides: { onSettings?: (settings: unknown) => void } = {}) {
  const storage = new MemoryStorageProvider()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const target = new URL(String(url))
      const key = target.searchParams.get('key')
      if (key !== null) {
        try {
          const bytes = await storage.get(key)
          return Response.json({ body: Buffer.from(bytes).toString('base64') })
        } catch {
          return Response.json({ error: 'not found' })
        }
      }
      if (String(url).startsWith(`${DAV_PUBLIC}/`)) {
        try {
          return new Response(await storage.get(String(url).slice(DAV_PUBLIC.length + 1)))
        } catch {
          return new Response(null, { status: 404 })
        }
      }
      return new Response(null, { status: 404 })
    }),
  )
  const wrapper = mount(ProvisionWizardView, {
    props: {
      kdf: TEST_KDF,
      createStorage: ((settings: unknown): MemoryStorageProvider => {
        overrides.onSettings?.(settings)
        return storage
      }) as never,
    },
  })
  mounted.push(wrapper)
  await fillGroupStep(wrapper)
  return wrapper
}

/** 開設は何段も非同期なので、結果か失敗が出るまで待つ。 */
async function settled(wrapper: VueWrapper) {
  await vi.waitFor(
    () => {
      const done = wrapper.find('[data-test="connection-code"]').exists()
      const failed = wrapper.find('[data-test="error"]').exists()
      if (!done && !failed) throw new Error('still working')
    },
    { timeout: 4000, interval: 10 },
  )
}

describe('choosing where the group lives (原稿 10)', () => {
  it('offers the three kinds of place', async () => {
    const wrapper = await atStorageStep()
    const kinds = wrapper.findAll('[data-test="storage-kind"]').map((el) => el.attributes('data-kind'))
    expect(kinds).toEqual(['s3', 'gdrive', 'webdav'])
  })

  it('asks only for what the chosen place needs', async () => {
    const wrapper = await atStorageStep()

    await wrapper.find('[data-test="storage-kind"][data-kind="gdrive"]').trigger('click')
    expect(wrapper.find('[data-test="function-url"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="access-key-id"]').exists()).toBe(false)

    await wrapper.find('[data-test="storage-kind"][data-kind="webdav"]').trigger('click')
    expect(wrapper.find('[data-test="dav-username"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="access-key-id"]').exists()).toBe(false)
    // WebDAV でも上りを受ける関数は任意で入れられる
    expect(wrapper.find('[data-test="function-url"]').exists()).toBe(true)
  })

  it('opens a group in Drive through the function', async () => {
    const seen: unknown[] = []
    const wrapper = await atStorageStep({ onSettings: (settings) => seen.push(settings) })

    await wrapper.find('[data-test="storage-kind"][data-kind="gdrive"]').trigger('click')
    await wrapper.get('[data-test="function-url"]').setValue('https://script.google.com/macros/s/AK/exec')
    await wrapper.get('[data-test="function-token"]').setValue('shared-secret')
    await wrapper.get('[data-test="next"]').trigger('click')
    await settled(wrapper)

    expect(seen[0]).toMatchObject({
      provider: 'gdrive',
      functionUrl: 'https://script.google.com/macros/s/AK/exec',
      token: 'shared-secret',
    })
    // 参加者に配る接続コードは、その関数を指す
    const { decodeConnectionCode: decode } = await import('../../src/group/connection-code')
    const code = decode(wrapper.get('[data-test="connection-code"]').text().trim())
    expect(code.provider).toBe('gdrive')
    expect(code.root).toBe('https://script.google.com/macros/s/AK/exec')
  })

  it('opens a group on WebDAV', async () => {
    const seen: unknown[] = []
    const wrapper = await atStorageStep({ onSettings: (settings) => seen.push(settings) })

    await wrapper.find('[data-test="storage-kind"][data-kind="webdav"]').trigger('click')
    await wrapper.get('[data-test="dav-url"]').setValue('https://nas.invalid/remote.php/dav/files/mofune')
    await wrapper.get('[data-test="public-base-url"]').setValue(DAV_PUBLIC)
    await wrapper.get('[data-test="dav-username"]').setValue('mofune')
    await wrapper.get('[data-test="dav-password"]').setValue('secret')
    await wrapper.get('[data-test="next"]').trigger('click')
    await settled(wrapper)

    expect(seen[0]).toMatchObject({ provider: 'webdav', username: 'mofune' })
    const { decodeConnectionCode: decode } = await import('../../src/group/connection-code')
    const code = decode(wrapper.get('[data-test="connection-code"]').text().trim())
    expect(code.provider).toBe('webdav')
    expect(code.root).toBe(DAV_PUBLIC)
  })

  it('says what is missing for the chosen place', async () => {
    const wrapper = await atStorageStep()
    await wrapper.find('[data-test="storage-kind"][data-kind="gdrive"]').trigger('click')
    await wrapper.get('[data-test="next"]').trigger('click')
    expect(wrapper.get('[data-test="error"]').text()).toContain('関数')
  })
})

describe('a WebDAV group and the uplink', () => {
  it('records the function so the staff can hand out tickets', async () => {
    const seen: unknown[] = []
    const wrapper = await atStorageStep({ onSettings: (settings) => seen.push(settings) })

    await wrapper.find('[data-test="storage-kind"][data-kind="webdav"]').trigger('click')
    await wrapper.get('[data-test="dav-url"]').setValue('https://nas.invalid/remote.php/dav/files/mofune')
    await wrapper.get('[data-test="public-base-url"]').setValue(DAV_PUBLIC)
    await wrapper.get('[data-test="dav-username"]').setValue('mofune')
    await wrapper.get('[data-test="dav-password"]').setValue('nas-secret')
    await wrapper.get('[data-test="function-url"]').setValue('https://script.google.com/macros/s/AK/exec')
    await wrapper.get('[data-test="function-token"]').setValue('shared-secret')
    await wrapper.get('[data-test="next"]').trigger('click')
    await settled(wrapper)

    expect(seen[0]).toMatchObject({
      provider: 'webdav',
      functionUrl: 'https://script.google.com/macros/s/AK/exec',
      token: 'shared-secret',
    })
  })

  it('opens without a function, and then simply has no uplink', async () => {
    const seen: unknown[] = []
    const wrapper = await atStorageStep({ onSettings: (settings) => seen.push(settings) })

    await wrapper.find('[data-test="storage-kind"][data-kind="webdav"]').trigger('click')
    await wrapper.get('[data-test="dav-url"]').setValue('https://nas.invalid/remote.php/dav/files/mofune')
    await wrapper.get('[data-test="public-base-url"]').setValue(DAV_PUBLIC)
    await wrapper.get('[data-test="dav-username"]').setValue('mofune')
    await wrapper.get('[data-test="dav-password"]').setValue('nas-secret')
    await wrapper.get('[data-test="next"]').trigger('click')
    await settled(wrapper)

    expect(seen[0]).not.toHaveProperty('functionUrl')
    expect(wrapper.find('[data-test="connection-code"]').exists()).toBe(true)
  })
})
