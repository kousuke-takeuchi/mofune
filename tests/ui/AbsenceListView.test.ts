// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import AbsenceListView from '../../src/ui/AbsenceListView.vue'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import type { CachedAbsence } from '../../src/db/group-db'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

const roster: RosterContents = {
  groupId: 'midori',
  generation: 1,
  subgroups: [],
  members: [
    {
      userId: 'u_sato',
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: ['all'],
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
  ],
}

function session(role: 'staff' | 'member' = 'staff'): Session {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role,
    scopes: ['all', 'staff'],
    groupKeys: new Map(),
    generation: 1,
    roster,
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
}

const older: CachedAbsence = {
  id: 'ab_old',
  kind: 'late',
  date: '2026-08-07',
  reason: '通院',
  note: '',
  author: 'u_sato',
  at: '2026-08-07T07:00:00.000Z',
}
const newer: CachedAbsence = {
  id: 'ab_new',
  kind: 'absent',
  date: '2026-08-08',
  reason: '体調不良',
  note: '朝から熱があります',
  author: 'u_sato',
  at: '2026-08-08T07:30:00.000Z',
}

let mounted: VueWrapper[] = []

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

async function mountList(role: 'staff' | 'member' = 'staff') {
  const wrapper = mount(AbsenceListView, { props: { session: session(role) } })
  mounted.push(wrapper)
  await vi.waitFor(() => {
    if (
      !wrapper.find('[data-test="ready"]').exists() &&
      !wrapper.find('[data-test="not-allowed"]').exists()
    ) {
      throw new Error('still loading')
    }
  }, { timeout: 2000, interval: 10 })
  return wrapper
}

describe('AbsenceListView', () => {
  it('shows an empty state when nothing has arrived', async () => {
    const wrapper = await mountList()
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true)
  })

  it('lists reports with the newest date first', async () => {
    await openGroupDatabase('midori').absences.bulkPut([older, newer])
    const wrapper = await mountList()
    const rows = wrapper.findAll('[data-test="absence"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('体調不良')
    expect(rows[1]?.text()).toContain('通院')
  })

  it('resolves the author to a display name', async () => {
    await openGroupDatabase('midori').absences.put(newer)
    const wrapper = await mountList()
    expect(wrapper.text()).toContain('佐藤 さくら')
    expect(wrapper.text()).not.toContain('u_sato')
  })

  it('falls back to a placeholder for an author who left the group', async () => {
    await openGroupDatabase('midori').absences.put({ ...newer, author: 'u_gone' })
    const wrapper = await mountList()
    expect(wrapper.text()).toContain('不明')
    expect(wrapper.text()).not.toContain('u_gone')
  })

  it('shows the kind in Japanese rather than the raw code', async () => {
    await openGroupDatabase('midori').absences.bulkPut([older, newer])
    const wrapper = await mountList()
    expect(wrapper.text()).toContain('欠席')
    expect(wrapper.text()).toContain('遅れます')
    expect(wrapper.text()).not.toContain('absent')
  })

  it('shows the free-text note when there is one', async () => {
    await openGroupDatabase('midori').absences.put(newer)
    const wrapper = await mountList()
    expect(wrapper.text()).toContain('朝から熱があります')
  })

  it('refuses to show anything to a member', async () => {
    await openGroupDatabase('midori').absences.put(newer)
    const wrapper = await mountList('member')
    expect(wrapper.find('[data-test="not-allowed"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="absence"]')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('体調不良')
  })

  it('emits close', async () => {
    const wrapper = await mountList()
    await wrapper.find('[data-test="close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
