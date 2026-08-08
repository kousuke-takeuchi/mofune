// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FormResultsView from '../../src/ui/FormResultsView.vue'
import type { FormDefinition } from '../../src/content/forms'
import type { StoredFormResponse } from '../../src/db/group-db'

const form: FormDefinition = {
  id: 'fm_1',
  kind: 'attendance',
  question: '来週の集まりに来ますか',
  choices: ['参加します', '欠席します'],
  allowNote: true,
  dueAt: '2026-08-12T09:00:00.000Z',
  recipient: { userId: 'u_tanaka', ecdhPublic: 'x' },
}

const responses: StoredFormResponse[] = [
  {
    id: 'fm_1:u_sato',
    formId: 'fm_1',
    messageId: 'm_1',
    userId: 'u_sato',
    displayName: '佐藤 さくら',
    choice: '参加します',
    note: '',
    at: '2026-08-08T09:00:00.000Z',
  },
]

function mountView(overrides: Record<string, unknown> = {}) {
  return mount(FormResultsView, {
    props: {
      form,
      responses,
      audience: 3,
      pending: [
        { userId: 'u_mori', displayName: '森 ゆい' },
        { userId: 'u_new', displayName: '新井 はじめ' },
      ],
      busy: false,
      error: '',
      ...overrides,
    },
  })
}

describe('FormResultsView', () => {
  it('lists who has not answered yet', () => {
    const rows = mountView().findAll('[data-test="pending"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('森 ゆい')
  })

  it('says everyone has answered rather than showing an empty list', () => {
    const wrapper = mountView({ pending: [] })
    expect(wrapper.find('[data-test="pending"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="all-answered"]').text()).toContain('全員')
  })

  it('offers to remind only the people who have not answered', async () => {
    const wrapper = mountView()
    expect(wrapper.get('[data-test="remind"]').text()).toContain('2')
    await wrapper.get('[data-test="remind"]').trigger('click')
    expect(wrapper.emitted('remind')).toBeTruthy()
  })

  it('does not offer a reminder when there is nobody to remind', () => {
    expect(mountView({ pending: [] }).find('[data-test="remind"]').exists()).toBe(false)
  })

  it('hands out the answers as a file that stays on the device', async () => {
    const wrapper = mountView()
    const link = wrapper.get('[data-test="csv"]')
    expect(link.attributes('download')).toContain('.csv')
    // data: URL なのでどこへも送らずに保存できる
    expect(link.attributes('href')?.startsWith('data:text/csv')).toBe(true)
    expect(decodeURIComponent(link.attributes('href') ?? '')).toContain('佐藤 さくら')
  })
})
