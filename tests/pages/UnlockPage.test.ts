// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import UnlockPage from '../../src/pages/UnlockPage.vue'
import { useSessionStore } from '../../src/stores/session'
import { registryDb } from '../../src/db/groups'
import { encodeConnectionCode } from '../../src/group/connection-code'

const push = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ query: { next: '/g/midori/messages/m_1' } }),
}))

async function remember(): Promise<void> {
  await registryDb.groups.put({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    code: encodeConnectionCode({
      v: 1,
      groupId: 'midori',
      provider: 's3',
      root: 'https://public.invalid',
      pepper: 'p',
      adminPublicKey: 'k',
    }),
    loginId: 'watanabe',
    lastLoginAt: 1,
  })
}

beforeEach(async () => {
  setActivePinia(createPinia())
  push.mockClear()
  await registryDb.groups.clear()
  await remember()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('UnlockPage', () => {
  it('shows the group and the login id it will use', async () => {
    const wrapper = mount(UnlockPage)
    await vi.waitFor(() => {
      if (!wrapper.text().includes('みどり台グループ')) throw new Error('not loaded')
    })
    expect(wrapper.text()).toContain('watanabe')
  })

  it('asks for the password only', async () => {
    const wrapper = mount(UnlockPage)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="password"]').exists()) throw new Error('not loaded')
    })
    expect(wrapper.find('[data-test="code"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="login-id"]').exists()).toBe(false)
  })

  it('returns to the screen the visitor came from', async () => {
    const session = useSessionStore()
    vi.spyOn(session, 'unlock').mockResolvedValue(undefined)
    const wrapper = mount(UnlockPage)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="password"]').exists()) throw new Error('not loaded')
    })
    await wrapper.find('[data-test="password"]').setValue('admin-pass')
    await wrapper.find('[data-test="unlock"]').trigger('click')
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/g/midori/messages/m_1'))
  })

  it('shows why the password was refused', async () => {
    const session = useSessionStore()
    vi.spyOn(session, 'unlock').mockRejectedValue(
      new Error('ログインIDまたはパスワードが正しくありません'),
    )
    const wrapper = mount(UnlockPage)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="password"]').exists()) throw new Error('not loaded')
    })
    await wrapper.find('[data-test="password"]').setValue('wrong')
    await wrapper.find('[data-test="unlock"]').trigger('click')
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="error"]').text()).toContain('パスワード'),
    )
    expect(push).not.toHaveBeenCalled()
  })

  it('offers a way to sign in as another group', async () => {
    const wrapper = mount(UnlockPage)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="switch-group"]').exists()) throw new Error('not loaded')
    })
    await wrapper.find('[data-test="switch-group"]').trigger('click')
    expect(push).toHaveBeenCalledWith({ name: 'login' })
  })

  it('forgets the device record on request', async () => {
    const wrapper = mount(UnlockPage)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="forget"]').exists()) throw new Error('not loaded')
    })
    await wrapper.find('[data-test="forget"]').trigger('click')
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith({ name: 'login' }))
    expect(await registryDb.groups.count()).toBe(0)
  })
})
