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
  return mount(MembersView, {
    props: { roster, busy, error: '', notice: '', currentUserId: 'u_admin' },
  })
}

/** 配り物のテストは接続コードを渡した状態で見る。 */
function mountWith(props: { connectionCode?: string }) {
  return mount(MembersView, {
    props: {
      roster,
      busy: false,
      error: '',
      notice: '',
      currentUserId: 'u_admin',
      ...props,
    },
  })
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
    for (const field of ['new-display-name', 'new-password', 'new-email']) {
      expect(wrapper.find(`[data-test="${field}"]`).exists()).toBe(true)
    }
  })

  it('hands the filled in member over', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="new-display-name"]').setValue('鈴木 ひなた')
    await wrapper.find('[data-test="new-password"]').setValue('hinata-pass')
    await wrapper.find('[data-test="new-email"]').setValue('suzuki@example.com')
    await wrapper.find('[data-test="scope-option"][data-scope="sg_a"]').setValue(true)
    await wrapper.find('[data-test="add"]').trigger('click')

    expect(wrapper.emitted('add')?.[0]?.[0]).toMatchObject({
      displayName: '鈴木 ひなた',
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

    await wrapper.find('[data-test="reissue-email"]').setValue('sato@example.invalid')
    await wrapper.find('[data-test="reissue-password"]').setValue('new-one')
    await wrapper.find('[data-test="reissue-confirm"]').trigger('click')
    expect(wrapper.emitted('reissue')?.[0]?.[0]).toMatchObject({
      userId: 'u_sato',
      email: 'sato@example.invalid',
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

  it('lists the subgroups that exist', () => {
    const rows = mountView().findAll('[data-test="subgroup"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('Aチーム')
    expect(rows[1]?.text()).toContain('送迎係')
  })

  it('shows a child subgroup under its parent', () => {
    const rows = mountView().findAll('[data-test="subgroup"]')
    expect(rows[1]?.text()).toContain('Aチーム の中')
  })

  it('creates a subgroup', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="new-subgroup-name"]').setValue('Bチーム')
    await wrapper.find('[data-test="create-subgroup"]').trigger('click')
    expect(wrapper.emitted('createSubgroup')?.[0]?.[0]).toEqual({
      name: 'Bチーム',
      parent: null,
    })
  })

  it('does not create one without a name', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="create-subgroup"]').trigger('click')
    expect(wrapper.emitted('createSubgroup')).toBeFalsy()
  })

  it('moves a member to the subgroups that were ticked', async () => {
    const wrapper = mountView()
    await wrapper.findAll('[data-test="edit-scopes"]')[1]?.trigger('click')
    await wrapper.find('[data-test="move-option"][data-scope="sg_a_pickup"]').setValue(true)
    await wrapper.find('[data-test="move-confirm"]').trigger('click')
    expect(wrapper.emitted('move')?.[0]?.[0]).toMatchObject({ userId: 'u_sato' })
    expect((wrapper.emitted('move')?.[0]?.[0] as { scopes: string[] }).scopes).toContain(
      'sg_a_pickup',
    )
  })

  it('warns that taking someone out does not take the key back', async () => {
    const wrapper = mountView()
    await wrapper.findAll('[data-test="edit-scopes"]')[1]?.trigger('click')
    expect(wrapper.text()).toContain('読めるまま')
  })

  it('asks twice before taking someone out of the group', async () => {
    const wrapper = mountView()
    await wrapper.findAll('[data-test="remove"]')[0]?.trigger('click')
    expect(wrapper.emitted('remove')).toBeFalsy()

    await wrapper.find('[data-test="remove-confirm"]').trigger('click')
    expect(wrapper.emitted('remove')?.[0]?.[0]).toEqual({ userId: 'u_sato' })
  })

  it('says plainly what removal does and does not do', async () => {
    const wrapper = mountView()
    await wrapper.findAll('[data-test="remove"]')[0]?.trigger('click')
    const text = wrapper.text()
    expect(text).toContain('これから配るもの')
    expect(text).toContain('すでに配ったもの')
  })

  it('does not offer to remove the admin who is signed in', () => {
    const wrapper = mount(MembersView, {
      props: { roster, busy: false, error: '', notice: '', currentUserId: 'u_admin' },
    })
    const rows = wrapper.findAll('[data-test="member"]')
    expect(rows[0]?.find('[data-test="remove"]').exists()).toBe(false)
    expect(rows[1]?.find('[data-test="remove"]').exists()).toBe(true)
  })

  it('moves a whole subgroup into another one', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="bulk-from"]').setValue('sg_a')
    await wrapper.find('[data-test="bulk-to"]').setValue('sg_a_pickup')
    await wrapper.find('[data-test="bulk-move"]').trigger('click')
    expect(wrapper.emitted('bulkMove')?.[0]?.[0]).toEqual({ from: 'sg_a', to: 'sg_a_pickup' })
  })

  it('does not move anything until both ends are chosen', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="bulk-move"]').trigger('click')
    expect(wrapper.emitted('bulkMove')).toBeFalsy()
  })
})

describe('handing the new member their QR', () => {
  it('shows a QR that carries the whole login, so nothing has to be typed', async () => {
    const wrapper = mountWith({ connectionCode: 'CODE' })

    await wrapper.get('[data-test="new-display-name"]').setValue('佐藤 さくら')
    await wrapper.get('[data-test="new-email"]').setValue('sato@example.com')
    await wrapper.get('[data-test="new-password"]').setValue('first-pass')
    await wrapper.get('[data-test="add"]').trigger('click')

    const handout = wrapper.get('[data-test="handout"]')
    expect(handout.text()).toContain('佐藤 さくら')
    expect(handout.text()).toContain('sato@example.com')
    // 読み取れば入れるので、紙の扱いに注意を書く
    expect(handout.text()).toContain('本人以外')
    expect(wrapper.find('[data-test="handout-qr"]').exists()).toBe(true)
  })

  it('does not show a QR before anyone has been added', () => {
    expect(mountWith({ connectionCode: 'CODE' }).find('[data-test="handout"]').exists()).toBe(false)
  })

  it('shows nothing to hand out when the group has no connection code at hand', async () => {
    const wrapper = mountWith({})
    await wrapper.get('[data-test="new-display-name"]').setValue('佐藤 さくら')
    await wrapper.get('[data-test="new-email"]').setValue('sato@example.com')
    await wrapper.get('[data-test="new-password"]').setValue('first-pass')
    await wrapper.get('[data-test="add"]').trigger('click')
    expect(wrapper.find('[data-test="handout-qr"]').exists()).toBe(false)
  })
})
