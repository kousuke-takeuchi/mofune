// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TimelinePage from '../../src/pages/TimelinePage.vue'
import { useSessionStore } from '../../src/stores/session'
import type { Session } from '../../src/group/session'
import { MemoryStorageProvider } from '../../src/storage/memory'

const push = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ params: { groupId: 'midori' } }),
}))

function signIn(role: 'admin' | 'member'): void {
  const store = useSessionStore()
  store.session = {
    groupId: 'midori',
    groupName: 'みどり台',
    userId: 'u_1',
    displayName: '渡辺',
    role,
    scopes: [],
    groupKeys: new Map(),
    roster: { groupId: 'midori', generation: 1, subgroups: [], members: [] },
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  } as unknown as Session
  store.storage = new MemoryStorageProvider()
}

beforeEach(() => {
  setActivePinia(createPinia())
  push.mockClear()
})

describe('TimelinePage', () => {
  it('opens a message by url', async () => {
    signIn('admin')
    const wrapper = mount(TimelinePage)
    wrapper.findComponent({ name: 'TimelineView' }).vm.$emit('open', 'm_1')
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith({
        name: 'message',
        params: { groupId: 'midori', messageId: 'm_1' },
      }),
    )
  })

  it('offers the staff actions to staff', () => {
    signIn('admin')
    const wrapper = mount(TimelinePage)
    expect(wrapper.find('[data-test="compose"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="staff-panel"]').exists()).toBe(true)
  })

  it('hides the staff actions from members', () => {
    signIn('member')
    const wrapper = mount(TimelinePage)
    expect(wrapper.find('[data-test="compose"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="staff-panel"]').exists()).toBe(false)
  })

  it('always offers a way to report an absence', () => {
    // 導線は下のナビへ移した (デザイン 03)。参加者にも必ず出る。
    signIn('member')
    expect(mount(TimelinePage).find('[data-test="nav-absence"]').exists()).toBe(true)
  })

  it('takes the visitor to the absence screen from the bottom nav', async () => {
    signIn('member')
    const wrapper = mount(TimelinePage)
    await wrapper.find('[data-test="nav-absence"]').trigger('click')
    expect(push).toHaveBeenCalledWith({ name: 'absence', params: { groupId: 'midori' } })
  })
})
