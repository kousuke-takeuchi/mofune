// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsView from '../../src/ui/SettingsView.vue'
import type { Session } from '../../src/group/session'

function session(role: 'admin' | 'member' = 'member'): Session {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_1',
    displayName: '佐藤 さくら',
    role,
    scopes: [],
    groupKeys: new Map(),
    generation: 1,
    roster: { groupId: 'midori', generation: 1, subgroups: [], members: [] },
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  } as unknown as Session
}

function mountView(overrides: Record<string, unknown> = {}) {
  return mount(SettingsView, {
    props: { session: session(), email: 'sakura.2026@example.invalid', lastSyncedAt: null, ...overrides },
  })
}

describe('SettingsView', () => {
  it('shows who is signed in and where', () => {
    const text = mountView().text()
    expect(text).toContain('佐藤 さくら')
    expect(text).toContain('sakura.2026')
    expect(text).toContain('みどり台グループ')
  })

  it('says the role in words rather than the internal name', () => {
    expect(mountView({ session: session('admin') }).text()).toContain('管理者')
    expect(mountView().text()).toContain('参加者')
  })

  it('says when the device last synced', () => {
    const wrapper = mountView({ lastSyncedAt: '2026-08-07T09:38:00.000Z' })
    expect(wrapper.find('[data-test="last-synced"]').text()).not.toBe('')
  })

  it('admits when it has never synced', () => {
    expect(mountView().find('[data-test="last-synced"]').text()).toContain('まだ')
  })

  it('offers to sign out', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="sign-out"]').trigger('click')
    expect(wrapper.emitted('signOut')).toBeTruthy()
  })

  it('asks for confirmation before unregistering the device', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="forget"]').trigger('click')
    // 一度目は確認だけ。接続コードを打ち直すことになるので、誤操作で消させない。
    expect(wrapper.emitted('forgetDevice')).toBeFalsy()
    expect(wrapper.find('[data-test="forget-confirm"]').exists()).toBe(true)

    await wrapper.find('[data-test="forget-confirm"]').trigger('click')
    expect(wrapper.emitted('forgetDevice')).toBeTruthy()
  })

  it('lets a member register their email address again', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="register-email"]').trigger('click')
    expect(wrapper.emitted('registerEmail')).toBeTruthy()
  })

  it('explains that contact details are not shown to other participants', () => {
    expect(mountView().text()).toContain('担当者')
  })
})
