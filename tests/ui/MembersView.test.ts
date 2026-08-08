// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MembersView from '../../src/ui/MembersView.vue'
import type { RosterContents } from '../../src/crypto/roster'

const roster: RosterContents = {
  groupId: 'midori',
  generation: 1,
  subgroups: [
    { id: 'sg_a', name: 'Aチーム', parent: null },
    { id: 'sg_a_pickup', name: '送迎係', parent: 'sg_a' },
  ],
  members: [
    {
      userId: 'u_admin',
      displayName: '渡辺 けい',
      role: 'admin',
      scopes: ['all', 'staff'],
      ecdhPublic: '',
      ecdsaPublic: '',
    },
    {
      userId: 'u_sato',
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: ['all', 'sg_a'],
      ecdhPublic: '',
      ecdsaPublic: '',
    },
  ],
}

function mountView(busy = false) {
  return mount(MembersView, { props: { roster, busy, error: '', notice: '' } })
}

describe('MembersView', () => {
  it('lists who is in the group with their role', () => {
    const rows = mountView().findAll('[data-test="member"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('渡辺 けい')
    expect(rows[0]?.text()).toContain('管理者')
    expect(rows[1]?.text()).toContain('参加者')
  })

  it('shows the subgroup by name rather than by id', () => {
    expect(mountView().findAll('[data-test="member"]')[1]?.text()).toContain('Aチーム')
  })

  it('offers every subgroup as a place to put someone', () => {
    const options = mountView()
      .findAll('[data-test="scope-option"]')
      .map((el) => el.attributes('data-scope'))
    expect(options).toEqual(['sg_a', 'sg_a_pickup'])
  })

  it('asks for everything the new member needs', async () => {
    const wrapper = mountView()
    for (const field of ['new-display-name', 'new-login-id', 'new-password', 'new-email']) {
      expect(wrapper.find(`[data-test="${field}"]`).exists()).toBe(true)
    }
  })

  it('hands the filled in member over', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="new-display-name"]').setValue('鈴木 ひなた')
    await wrapper.find('[data-test="new-login-id"]').setValue('suzuki')
    await wrapper.find('[data-test="new-password"]').setValue('hinata-pass')
    await wrapper.find('[data-test="new-email"]').setValue('suzuki@example.com')
    await wrapper.find('[data-test="scope-option"][data-scope="sg_a"]').setValue(true)
    await wrapper.find('[data-test="add"]').trigger('click')

    expect(wrapper.emitted('add')?.[0]?.[0]).toMatchObject({
      displayName: '鈴木 ひなた',
      loginId: 'suzuki',
      password: 'hinata-pass',
      email: 'suzuki@example.com',
      role: 'member',
      scopes: ['sg_a'],
    })
  })

  it('does not hand over an empty form', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="add"]').trigger('click')
    expect(wrapper.emitted('add')).toBeFalsy()
    expect(wrapper.find('[data-test="form-error"]').exists()).toBe(true)
  })

  it('warns that a new member can read what was posted before they joined', () => {
    expect(mountView().text()).toContain('過去')
  })

  it('asks twice before reissuing a password', async () => {
    const wrapper = mountView()
    await wrapper.findAll('[data-test="reissue"]')[1]?.trigger('click')
    expect(wrapper.emitted('reissue')).toBeFalsy()

    await wrapper.find('[data-test="reissue-login-id"]').setValue('sato')
    await wrapper.find('[data-test="reissue-password"]').setValue('new-one')
    await wrapper.find('[data-test="reissue-confirm"]').trigger('click')
    expect(wrapper.emitted('reissue')?.[0]?.[0]).toMatchObject({
      userId: 'u_sato',
      loginId: 'sato',
      password: 'new-one',
    })
  })

  it('says the old password stops working', async () => {
    const wrapper = mountView()
    await wrapper.findAll('[data-test="reissue"]')[1]?.trigger('click')
    expect(wrapper.text()).toContain('使えなくなります')
  })

  it('keeps the buttons quiet while a change is in flight', () => {
    expect(mountView(true).find('[data-test="add"]').attributes('disabled')).toBeDefined()
  })
})
