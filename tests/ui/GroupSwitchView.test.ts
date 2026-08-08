// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import GroupSwitchView from '../../src/ui/GroupSwitchView.vue'
import type { StoredGroup } from '../../src/db/groups'

const groups: StoredGroup[] = [
  {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    code: 'x',
    email: 'sakura.2026@example.invalid',
    lastLoginAt: 2,
  },
  {
    groupId: 'doyou',
    groupName: '土曜クラブ',
    code: 'y',
    email: 'tanaka@example.invalid',
    lastLoginAt: 1,
  },
]

/** 何も待っていない状態を土台に、見たいところだけ上書きする。 */
function quiet(groupId: string, overrides: Record<string, number>) {
  const base = {
    groupId,
    unread: 0,
    needsAnswer: 0,
    unsentBatches: 0,
    lastSyncedAt: null as string | null,
  }
  const merged = { ...base, ...overrides }
  return {
    ...merged,
    needsAttention: merged.unread > 0 || merged.needsAnswer > 0 || merged.unsentBatches > 0,
  }
}

describe('GroupSwitchView', () => {
  it('lists the groups this device knows', () => {
    const wrapper = mount(GroupSwitchView, { props: { groups, currentGroupId: 'midori', overview: {} } })
    const names = wrapper.findAll('[data-test="group"]').map((item) => item.text())
    expect(names).toHaveLength(2)
    expect(names[0]).toContain('みどり台グループ')
    expect(names[1]).toContain('土曜クラブ')
  })

  it('marks the group that is open now', () => {
    const wrapper = mount(GroupSwitchView, { props: { groups, currentGroupId: 'midori', overview: {} } })
    expect(wrapper.find('[data-test="group"][data-current="true"]').text()).toContain('みどり台')
  })

  it('opens the group that was chosen', async () => {
    const wrapper = mount(GroupSwitchView, { props: { groups, currentGroupId: 'midori', overview: {} } })
    await wrapper.findAll('[data-test="group"]')[1]?.trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual(['doyou'])
  })

  it('shows how many are unread in each group', () => {
    const wrapper = mount(GroupSwitchView, {
      props: {
        groups,
        currentGroupId: 'midori',
        overview: { midori: quiet('midori', { unread: 2 }), doyou: quiet('doyou', {}) },
      },
    })
    const rows = wrapper.findAll('[data-test="group"]')
    expect(rows[0]?.text()).toContain('未読 2')
    // 0 件のときは何も出さない。ゼロのバッジは目に入るだけで意味が無い。
    expect(rows[1]?.text()).not.toContain('未読')
  })

  it('offers a way in for a group this device does not know yet', async () => {
    const wrapper = mount(GroupSwitchView, { props: { groups, currentGroupId: null, overview: {} } })
    await wrapper.find('[data-test="add"]').trigger('click')
    expect(wrapper.emitted('add')).toBeTruthy()
  })

  it('says so when the device knows no group at all', () => {
    const wrapper = mount(GroupSwitchView, { props: { groups: [], currentGroupId: null, overview: {} } })
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true)
  })
})

describe('the cross-group view (原稿 11)', () => {
  function mountWith(overview: Record<string, ReturnType<typeof quiet>>) {
    return mount(GroupSwitchView, { props: { groups, currentGroupId: 'midori', overview } })
  }

  it('shows what is waiting in each group', () => {
    const wrapper = mountWith({ midori: quiet('midori', { unread: 3, needsAnswer: 1 }) })
    const text = wrapper.findAll('[data-test="group"]')[0]?.text() ?? ''
    expect(text).toContain('未読 3')
    expect(text).toContain('要回答 1')
  })

  it('tells the staff about mail nobody has sent', () => {
    const wrapper = mountWith({ midori: quiet('midori', { unsentBatches: 2 }) })
    expect(wrapper.findAll('[data-test="group"]')[0]?.text()).toContain('未送信 2')
  })

  it('says nothing extra for a quiet group', () => {
    const wrapper = mountWith({ midori: quiet('midori', {}) })
    const text = wrapper.findAll('[data-test="group"]')[0]?.text() ?? ''
    expect(text).not.toContain('未読')
    expect(text).not.toContain('要回答')
    expect(text).not.toContain('未送信')
  })
})
