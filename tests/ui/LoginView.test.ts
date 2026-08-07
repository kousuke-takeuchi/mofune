// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import LoginView from '../../src/ui/LoginView.vue'
import { provisionGroup, writeObjects } from '../../src/group/provision'
import { encodeConnectionCode } from '../../src/group/connection-code'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { registryDb } from '../../src/db/groups'

async function buildGroup(): Promise<{ code: string; storage: MemoryStorageProvider }> {
  const result = await provisionGroup({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    provider: 'http',
    root: 'https://example.invalid/mofune',
    kdf: TEST_KDF,
    subgroups: [{ id: 'sg_a', name: 'Aチーム', parent: null }],
    members: [
      {
        loginId: 'watanabe',
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
  return { code: encodeConnectionCode(result.code), storage }
}

/** 接続コードの provider が http のとき、fetch をインメモリストレージに向ける。 */
function routeFetchTo(storage: MemoryStorageProvider): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.replace('https://example.invalid/mofune/', '')
      try {
        return new Response(await storage.get(path))
      } catch {
        return new Response('', { status: 404 })
      }
    }),
  )
}

beforeEach(async () => {
  await registryDb.groups.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LoginView', () => {
  it('renders the three input fields', () => {
    const wrapper = mount(LoginView)
    expect(wrapper.find('[data-test="code"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="login-id"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="password"]').exists()).toBe(true)
  })

  it('masks the password field', () => {
    const wrapper = mount(LoginView)
    expect(wrapper.find('[data-test="password"]').attributes('type')).toBe('password')
  })

  it('emits the session after a successful login', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    const wrapper = mount(LoginView)
    await wrapper.find('[data-test="code"]').setValue(code)
    await wrapper.find('[data-test="login-id"]').setValue('watanabe')
    await wrapper.find('[data-test="password"]').setValue('admin-pass')
    await wrapper.find('[data-test="submit"]').trigger('submit')
    await vi.waitFor(() => expect(wrapper.emitted('login')).toBeTruthy())
    const [session] = wrapper.emitted('login')?.[0] as [{ displayName: string }]
    expect(session.displayName).toBe('渡辺 けい')
  })

  it('remembers the group after a successful login', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    const wrapper = mount(LoginView)
    await wrapper.find('[data-test="code"]').setValue(code)
    await wrapper.find('[data-test="login-id"]').setValue('watanabe')
    await wrapper.find('[data-test="password"]').setValue('admin-pass')
    await wrapper.find('[data-test="submit"]').trigger('submit')
    await vi.waitFor(() => expect(wrapper.emitted('login')).toBeTruthy())
    expect(await registryDb.groups.get('midori')).toBeDefined()
  })

  it('shows an error for a malformed connection code', async () => {
    const wrapper = mount(LoginView)
    await wrapper.find('[data-test="code"]').setValue('not-a-code!!')
    await wrapper.find('[data-test="login-id"]').setValue('watanabe')
    await wrapper.find('[data-test="password"]').setValue('admin-pass')
    await wrapper.find('[data-test="submit"]').trigger('submit')
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="error"]').text().length).toBeGreaterThan(0),
    )
    expect(wrapper.emitted('login')).toBeFalsy()
  })

  it('shows an error for a wrong password without emitting a session', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    const wrapper = mount(LoginView)
    await wrapper.find('[data-test="code"]').setValue(code)
    await wrapper.find('[data-test="login-id"]').setValue('watanabe')
    await wrapper.find('[data-test="password"]').setValue('wrong')
    await wrapper.find('[data-test="submit"]').trigger('submit')
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="error"]').text()).toContain('ログインID'),
    )
    expect(wrapper.emitted('login')).toBeFalsy()
  })

  it('reports unsupported storage providers instead of failing obscurely', async () => {
    const wrapper = mount(LoginView)
    await wrapper.find('[data-test="code"]').setValue(
      encodeConnectionCode({
        v: 1,
        groupId: 'midori',
        provider: 'dropbox',
        root: 'x',
        pepper: 'p',
        adminPublicKey: 'k',
      }),
    )
    await wrapper.find('[data-test="login-id"]').setValue('watanabe')
    await wrapper.find('[data-test="password"]').setValue('admin-pass')
    await wrapper.find('[data-test="submit"]').trigger('submit')
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="error"]').text()).toContain('dropbox'),
    )
  })
})
