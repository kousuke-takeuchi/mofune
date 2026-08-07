// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import ProvisionWizardView from '../../src/ui/ProvisionWizardView.vue'
import { MemoryStorageProvider } from '../../src/storage/memory'
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
  await wrapper.find('[data-test="admin-login-id"]').setValue('watanabe')
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
