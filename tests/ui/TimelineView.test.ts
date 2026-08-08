// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
    generation: 1,
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
    // syncGroup → reload は IndexedDB を何往復もする。回数を決め打ちにすると、
    // 往復が1つ増えただけで落ちる。検証したい状態そのものを待つ。
    await vi.waitFor(() => expect(wrapper.findAll('[data-test="message"]')).toHaveLength(1))
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

  it('offers a way to see only the unread ones', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    await db.syncState.put({ key: 'lastReadAt', value: '2026-08-06T00:00:00.000Z' })
    const wrapper = await mountTimeline()
    expect(wrapper.findAll('[data-test="message"]')).toHaveLength(2)

    await wrapper.find('[data-test="tab-unread"]').trigger('click')
    const shown = wrapper.findAll('[data-test="message"]')
    expect(shown).toHaveLength(1)
    expect(shown[0]?.text()).toContain('来週の集まりについて')
  })

  it('comes back to everything when the tab is switched back', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    await db.syncState.put({ key: 'lastReadAt', value: '2026-08-06T00:00:00.000Z' })
    const wrapper = await mountTimeline()
    await wrapper.find('[data-test="tab-unread"]').trigger('click')
    await wrapper.find('[data-test="tab-all"]').trigger('click')
    expect(wrapper.findAll('[data-test="message"]')).toHaveLength(2)
  })

  it('marks which tab is showing', async () => {
    const wrapper = await mountTimeline()
    expect(wrapper.find('[data-test="tab-all"]').attributes('aria-pressed')).toBe('true')
    await wrapper.find('[data-test="tab-unread"]').trigger('click')
    expect(wrapper.find('[data-test="tab-unread"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-test="tab-all"]').attributes('aria-pressed')).toBe('false')
  })

  it('says so when the unread tab has nothing in it', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    await db.syncState.put({ key: 'lastReadAt', value: '2026-08-08T00:00:00.000Z' })
    const wrapper = await mountTimeline()
    await wrapper.find('[data-test="tab-unread"]').trigger('click')
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true)
  })

  it('shows a title above the body when the post has one', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put({ ...newer, title: '来週の集まりについて' })
    const wrapper = await mountTimeline()
    expect(wrapper.find('[data-test="message"] .message-title').text()).toBe('来週の集まりについて')
  })

  it('shows a thumbnail for each cached image, up to three', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put({ ...newer, attachments: ['f_1', 'f_2', 'f_3', 'f_4'] })
    for (const id of ['f_1', 'f_2', 'f_3', 'f_4']) {
      await db.files.put({
        id,
        mediaType: 'image/png',
        size: 3,
        blob: new Uint8Array([1, 2, 3]),
        cachedAt: '2026-08-07T00:00:00.000Z',
      })
    }
    const wrapper = await mountTimeline()
    await vi.waitFor(() => {
      if (wrapper.findAll('[data-test="thumb"]').length !== 3) throw new Error('not yet')
    })
    // 4枚目以降は枚数で示す (原稿 03 の「+9」)
    expect(wrapper.find('[data-test="thumb-more"]').text()).toContain('1')
  })

  it('does not promise a thumbnail it has not received yet', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put({ ...newer, attachments: ['f_missing'] })
    const wrapper = await mountTimeline()
    expect(wrapper.findAll('[data-test="thumb"]')).toHaveLength(0)
  })
})

describe('the header and the cards, as the design draws them', () => {
  it('puts the subgroups I belong to under the group name', async () => {
    const wrapper = mount(TimelineView, {
      props: {
        session: {
          ...(await session()),
          roster: {
            groupId: 'midori',
            generation: 1,
            subgroups: [
              { id: 'sg_a', name: 'Aチーム', parent: null },
              { id: 'sg_b', name: 'Bチーム', parent: null },
            ],
            members: [],
          },
        } as Session,
        storage: new MemoryStorageProvider(),
      },
    })
    mounted.push(wrapper)
    await flushPromises()

    const subtitle = wrapper.get('[data-test="belongs-to"]').text()
    expect(subtitle).toContain('Aチーム')
    expect(subtitle).toContain('佐藤 さくら')
    expect(subtitle).not.toContain('Bチーム')
  })

  it('shows when the last sync happened', async () => {
    const db = openGroupDatabase('midori')
    await db.syncState.put({ key: 'lastSyncedAt', value: '2026-08-07T09:12:00.000Z' })
    const wrapper = await mountTimeline()
    expect(wrapper.get('[data-test="sync-chip"]').text()).toContain('同期済み')
  })

  it('says it has never synced when it has not', async () => {
    const wrapper = await mountTimeline()
    expect(wrapper.get('[data-test="sync-chip"]').text()).toContain('未同期')
  })

  it('marks a post that wants an answer, and offers the button in the card', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put({
      ...newer,
      form: { id: 'fm_1', kind: 'attendance', question: '来ますか', choices: ['行く', '行かない'] },
    } as CachedMessage)
    const wrapper = await mountTimeline()

    expect(wrapper.get('[data-test="needs-answer"]').text()).toContain('要回答')
    await wrapper.get('[data-test="answer"]').trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual(['m_new'])
  })

  it('does not mark a plain post', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put(newer)
    const wrapper = await mountTimeline()
    expect(wrapper.find('[data-test="needs-answer"]').exists()).toBe(false)
  })
})

describe('the 要回答 tab', () => {
  it('keeps only the posts that ask for an answer', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([
      older,
      {
        ...newer,
        form: {
          id: 'fm_1',
          kind: 'attendance',
          question: '来ますか',
          choices: ['行く', '行かない'],
          allowNote: false,
          dueAt: null,
          recipient: { userId: 'u_tanaka', ecdhPublic: 'AAAA' },
        },
      } as CachedMessage,
    ])
    const wrapper = await mountTimeline()

    await wrapper.get('[data-test="tab-answer"]').trigger('click')
    const items = wrapper.findAll('[data-test="message"]')
    expect(items).toHaveLength(1)
    expect(items[0]?.text()).toContain('来週の集まりについて')
  })

  it('drops a post whose deadline has passed', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put({
      ...newer,
      form: {
        id: 'fm_1',
        kind: 'attendance',
        question: '来ますか',
        choices: ['行く', '行かない'],
        allowNote: false,
        dueAt: '2020-01-01T00:00:00.000Z',
        recipient: { userId: 'u_tanaka', ecdhPublic: 'AAAA' },
      },
    } as CachedMessage)
    const wrapper = await mountTimeline()

    await wrapper.get('[data-test="tab-answer"]').trigger('click')
    expect(wrapper.get('[data-test="empty"]').text()).toContain('要回答')
  })
})
