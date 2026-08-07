// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import TimelineView from '../../src/ui/TimelineView.vue'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import type { Session } from '../../src/group/session'
import type { CachedMessage } from '../../src/db/group-db'

async function session(): Promise<Session> {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_sato',
    displayName: '佐藤 さくら',
    role: 'member',
    scopes: ['all', 'sg_a'],
    groupKeys: new Map([['sg_a:v1', await generateAesKey()]]),
    roster: { groupId: 'midori', generation: 1, subgroups: [], members: [] },
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
}

const older: CachedMessage = {
  id: 'm_old',
  scopes: ['sg_a'],
  author: 'u_tanaka',
  at: '2026-08-05T08:02:00.000Z',
  body: '8月の予定表',
  attachments: [],
}
const newer: CachedMessage = {
  id: 'm_new',
  scopes: ['sg_a'],
  author: 'u_tanaka',
  at: '2026-08-07T09:12:00.000Z',
  body: '来週の集まりについて',
  attachments: ['f_1'],
}

let mounted: VueWrapper[] = []

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

// DB を消す前にコンポーネントを外さないと、進行中の読み取りが
// DatabaseClosedError で未処理のまま落ちる。
afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

async function mountTimeline() {
  const wrapper = mount(TimelineView, {
    props: { session: await session(), storage: new MemoryStorageProvider() },
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

describe('TimelineView', () => {
  it('shows the group name', async () => {
    const wrapper = await mountTimeline()
    expect(wrapper.text()).toContain('みどり台グループ')
  })

  it('lists cached messages newest first', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    const wrapper = await mountTimeline()
    const items = wrapper.findAll('[data-test="message"]')
    expect(items).toHaveLength(2)
    expect(items[0]?.text()).toContain('来週の集まりについて')
    expect(items[1]?.text()).toContain('8月の予定表')
  })

  it('shows an empty state when there is nothing yet', async () => {
    const wrapper = await mountTimeline()
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="message"]')).toHaveLength(0)
  })

  it('counts every message as unread before anything has been read', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    const wrapper = await mountTimeline()
    expect(wrapper.find('[data-test="unread-count"]').text()).toBe('2')
  })

  it('counts only messages newer than lastReadAt as unread', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    await db.syncState.put({ key: 'lastReadAt', value: '2026-08-06T00:00:00.000Z' })
    const wrapper = await mountTimeline()
    expect(wrapper.find('[data-test="unread-count"]').text()).toBe('1')
  })

  it('marks individual messages as unread', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    await db.syncState.put({ key: 'lastReadAt', value: '2026-08-06T00:00:00.000Z' })
    const wrapper = await mountTimeline()
    const items = wrapper.findAll('[data-test="message"]')
    expect(items[0]?.attributes('data-unread')).toBe('true')
    expect(items[1]?.attributes('data-unread')).toBe('false')
  })

  it('shows an attachment indicator only for messages that have one', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    const wrapper = await mountTimeline()
    const items = wrapper.findAll('[data-test="message"]')
    expect(items[0]?.find('[data-test="has-attachment"]').exists()).toBe(true)
    expect(items[1]?.find('[data-test="has-attachment"]').exists()).toBe(false)
  })

  it('emits open with the message id when a message is clicked', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put(newer)
    const wrapper = await mountTimeline()
    await wrapper.find('[data-test="message"]').trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual(['m_new'])
  })

  it('refreshes the list after a manual sync', async () => {
    const wrapper = await mountTimeline()
    expect(wrapper.findAll('[data-test="message"]')).toHaveLength(0)
    await openGroupDatabase('midori').messages.put(newer)
    await wrapper.find('[data-test="sync"]').trigger('click')
    // syncGroup → reload と非同期が多段なので、1ティックでは足りない
    await flushPromises()
    await flushPromises()
    expect(wrapper.findAll('[data-test="message"]')).toHaveLength(1)
  })

  it('reports a sync failure without losing the cached list', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put(newer)
    const failing = {
      capabilities: { read: true, write: false, list: false, inbox: false },
      get: () => Promise.reject(new Error('offline')),
      put: () => Promise.reject(new Error('offline')),
      delete: () => Promise.reject(new Error('offline')),
      list: () => Promise.reject(new Error('offline')),
    }
    const wrapper = mount(TimelineView, {
      props: { session: await session(), storage: failing as never },
    })
    mounted.push(wrapper)
    await flushPromises()
    await wrapper.find('[data-test="sync"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="sync-error"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="message"]')).toHaveLength(1)
  })
})
