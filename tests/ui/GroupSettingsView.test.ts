// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import GroupSettingsView from '../../src/ui/GroupSettingsView.vue'
import { DEFAULT_GROUP_SETTINGS } from '../../src/group/group-settings'
import type { Subgroup } from '../../src/crypto/roster'

const subgroups: Subgroup[] = [
  { id: 'sg_a', name: 'Aチーム', parent: null },
  { id: 'sg_b', name: 'Bチーム', parent: null },
]

function mountView(overrides: Record<string, unknown> = {}) {
  return mount(GroupSettingsView, {
    props: {
      settings: DEFAULT_GROUP_SETTINGS,
      subgroups,
      busy: false,
      error: '',
      notice: '',
      ...overrides,
    },
  })
}

describe('GroupSettingsView', () => {
  it('shows the reasons people can pick from', () => {
    const rows = mountView().findAll('[data-test="reason"]')
    expect(rows.length).toBe(DEFAULT_GROUP_SETTINGS.absenceReasons.length)
    expect(rows[0]?.text()).toContain('体調不良')
  })

  it('adds a reason', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="new-reason"]').setValue('学校行事')
    await wrapper.find('[data-test="add-reason"]').trigger('click')
    await wrapper.find('[data-test="save"]').trigger('click')

    const saved = wrapper.emitted('save')?.[0]?.[0] as typeof DEFAULT_GROUP_SETTINGS
    expect(saved.absenceReasons).toContain('学校行事')
  })

  it('removes a reason', async () => {
    const wrapper = mountView()
    await wrapper.findAll('[data-test="remove-reason"]')[0]?.trigger('click')
    await wrapper.find('[data-test="save"]').trigger('click')

    const saved = wrapper.emitted('save')?.[0]?.[0] as typeof DEFAULT_GROUP_SETTINGS
    expect(saved.absenceReasons).not.toContain('体調不良')
  })

  it('edits the mail the notification uses', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="mail-subject"]').setValue('{{グループ名}} からお知らせ')
    await wrapper.find('[data-test="save"]').trigger('click')

    const saved = wrapper.emitted('save')?.[0]?.[0] as typeof DEFAULT_GROUP_SETTINGS
    expect(saved.mailTemplate.subject).toBe('{{グループ名}} からお知らせ')
  })

  it('says which placeholders may be used, and that the body never goes in the mail', () => {
    const text = mountView().text()
    expect(text).toContain('{{グループ名}}')
    expect(text).toContain('本文')
  })

  it('lists every subgroup as something that can be muted', () => {
    const options = mountView()
      .findAll('[data-test="mute-option"]')
      .map((el) => el.attributes('data-scope'))
    expect(options).toEqual(['all', 'sg_a', 'sg_b'])
  })

  it('mutes a subgroup', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-test="mute-option"][data-scope="sg_b"]').setValue(true)
    await wrapper.find('[data-test="save"]').trigger('click')

    const saved = wrapper.emitted('save')?.[0]?.[0] as typeof DEFAULT_GROUP_SETTINGS
    expect(saved.notifications.mutedScopes).toEqual(['sg_b'])
  })

  it('starts from what is already stored', () => {
    const wrapper = mountView({
      settings: {
        ...DEFAULT_GROUP_SETTINGS,
        notifications: { mutedScopes: ['sg_a'], channels: ['mailto'] },
      },
    })
    const checked = wrapper.find('[data-test="mute-option"][data-scope="sg_a"]')
      .element as HTMLInputElement
    expect(checked.checked).toBe(true)
  })
})

describe('the notification function (原稿 08)', () => {
  it('shows the url and the shared secret so they can be changed', async () => {
    const wrapper = mountView({
      settings: {
        ...DEFAULT_GROUP_SETTINGS,
        notifications: { ...DEFAULT_GROUP_SETTINGS.notifications, functionToken: 'secret' },
      },
      functionUrl: 'https://push.invalid',
    })

    expect((wrapper.get('[data-test="function-url"]').element as HTMLInputElement).value).toBe(
      'https://push.invalid',
    )
    expect((wrapper.get('[data-test="function-token"]').element as HTMLInputElement).value).toBe(
      'secret',
    )
  })

  it('hands both back on save, because they are set together', async () => {
    const wrapper = mountView({ functionUrl: '' })
    await wrapper.get('[data-test="function-url"]').setValue('https://push.invalid')
    await wrapper.get('[data-test="function-token"]').setValue('secret')
    await wrapper.get('[data-test="save"]').trigger('click')

    const [settings, functionUrl] = wrapper.emitted('save')?.[0] as [
      { notifications: { functionToken: string } },
      string,
    ]
    expect(settings.notifications.functionToken).toBe('secret')
    expect(functionUrl).toBe('https://push.invalid')
  })
})
