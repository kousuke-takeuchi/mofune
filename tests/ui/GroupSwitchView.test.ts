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
    loginId: 'sakura.2026',
    lastLoginAt: 2,
  },
  {
    groupId: 'doyou',
    groupName: '土曜クラブ',
    code: 'y',
    loginId: 'tanaka',
    lastLoginAt: 1,
  },
]

describe('GroupSwitchView', () => {
  it('lists the groups this device knows', () => {
    const wrapper = mount(GroupSwitchView, { props: { groups, currentGroupId: 'midori' } })
    const names = wrapper.findAll('[data-test="group"]').map((item) => item.text())
    expect(names).toHaveLength(2)
    expect(names[0]).toContain('みどり台グループ')
    expect(names[1]).toContain('土曜クラブ')
  })

  it('marks the group that is open now', () => {
    const wrapper = mount(GroupSwitchView, { props: { groups, currentGroupId: 'midori' } })
    expect(wrapper.find('[data-test="group"][data-current="true"]').text()).toContain('みどり台')
  })

  it('opens the group that was chosen', async () => {
    const wrapper = mount(GroupSwitchView, { props: { groups, currentGroupId: 'midori' } })
    await wrapper.findAll('[data-test="group"]')[1]?.trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual(['doyou'])
  })

  it('offers a way in for a group this device does not know yet', async () => {
    const wrapper = mount(GroupSwitchView, { props: { groups, currentGroupId: null } })
    await wrapper.find('[data-test="add"]').trigger('click')
    expect(wrapper.emitted('add')).toBeTruthy()
  })

  it('says so when the device knows no group at all', () => {
    const wrapper = mount(GroupSwitchView, { props: { groups: [], currentGroupId: null } })
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true)
  })
})
