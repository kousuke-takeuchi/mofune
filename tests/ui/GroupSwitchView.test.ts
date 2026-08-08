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

describe('GroupSwitchView', () => {
  it('lists the groups this device knows', () => {
    const wrapper = mount(GroupSwitchView, { props: { groups, currentGroupId: 'midori', unread: {} } })
    const names = wrapper.findAll('[data-test="group"]').map((item) => item.text())
    expect(names).toHaveLength(2)
    expect(names[0]).toContain('みどり台グループ')
    expect(names[1]).toContain('土曜クラブ')
  })

  it('marks the group that is open now', () => {
    const wrapper = mount(GroupSwitchView, { props: { groups, currentGroupId: 'midori', unread: {} } })
    expect(wrapper.find('[data-test="group"][data-current="true"]').text()).toContain('みどり台')
  })

  it('opens the group that was chosen', async () => {
    const wrapper = mount(GroupSwitchView, { props: { groups, currentGroupId: 'midori', unread: {} } })
    await wrapper.findAll('[data-test="group"]')[1]?.trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual(['doyou'])
  })

  it('shows how many are unread in each group', () => {
    const wrapper = mount(GroupSwitchView, {
      props: { groups, currentGroupId: 'midori', unread: { midori: 2, doyou: 0 } },
    })
    const rows = wrapper.findAll('[data-test="group"]')
    expect(rows[0]?.text()).toContain('未読 2')
    // 0 件のときは何も出さない。ゼロのバッジは目に入るだけで意味が無い。
    expect(rows[1]?.text()).not.toContain('未読')
  })

  it('offers a way in for a group this device does not know yet', async () => {
    const wrapper = mount(GroupSwitchView, { props: { groups, currentGroupId: null, unread: {} } })
    await wrapper.find('[data-test="add"]').trigger('click')
    expect(wrapper.emitted('add')).toBeTruthy()
  })

  it('says so when the device knows no group at all', () => {
    const wrapper = mount(GroupSwitchView, { props: { groups: [], currentGroupId: null, unread: {} } })
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true)
  })
})
