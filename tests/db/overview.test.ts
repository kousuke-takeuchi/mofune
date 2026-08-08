import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { groupOverview, overviewFor } from '../../src/db/overview'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import type { CachedMessage } from '../../src/db/group-db'

function message(id: string, at: string, form?: CachedMessage['form']): CachedMessage {
  return {
    id,
    scopes: ['all'],
    author: 'u_tanaka',
    at,
    body: '本文',
    attachments: [],
    ...(form ? { form } : {}),
  }
}

const openForm = {
  id: 'fm_1',
  kind: 'attendance' as const,
  question: '来ますか',
  choices: ['行く', '行かない'],
  allowNote: false,
  dueAt: null,
  recipient: { userId: 'u_tanaka', ecdhPublic: 'x' },
}

const closedForm = { ...openForm, id: 'fm_2', dueAt: '2020-01-01T00:00:00.000Z' }

beforeEach(async () => {
  await deleteGroupDatabase('midori')
  await deleteGroupDatabase('sakura')
})

describe('groupOverview', () => {
  it('counts what is waiting in one group', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([
      message('m_1', '2026-08-07T09:00:00.000Z'),
      message('m_2', '2026-08-08T09:00:00.000Z', openForm),
      message('m_3', '2026-08-08T10:00:00.000Z', closedForm),
    ])
    await db.syncState.put({ key: 'lastReadAt', value: '2026-08-07T12:00:00.000Z' })
    await db.syncState.put({ key: 'lastSyncedAt', value: '2026-08-08T11:00:00.000Z' })
    await db.deliveries.put({
      id: 'm_2#1',
      messageId: 'm_2',
      batchIndex: 1,
      total: 1,
      recipients: 5,
      sentAt: null,
    })

    const overview = await groupOverview('midori')
    expect(overview.unread).toBe(2)
    // 締切を過ぎた問いは答えられないので数えない
    expect(overview.needsAnswer).toBe(1)
    expect(overview.unsentBatches).toBe(1)
    expect(overview.lastSyncedAt).toBe('2026-08-08T11:00:00.000Z')
    expect(overview.needsAttention).toBe(true)
  })

  it('is quiet for a group with nothing pending', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put(message('m_1', '2026-08-07T09:00:00.000Z'))
    await db.syncState.put({ key: 'lastReadAt', value: '2026-08-09T00:00:00.000Z' })

    const overview = await groupOverview('midori')
    expect(overview).toMatchObject({ unread: 0, needsAnswer: 0, unsentBatches: 0 })
    expect(overview.needsAttention).toBe(false)
  })

  it('says nothing is waiting for a group this device has never opened', async () => {
    const overview = await groupOverview('never-seen')
    expect(overview).toMatchObject({
      groupId: 'never-seen',
      unread: 0,
      needsAnswer: 0,
      unsentBatches: 0,
      lastSyncedAt: null,
    })
  })
})

describe('overviewFor', () => {
  it('gives one entry per group, keyed by id', async () => {
    await openGroupDatabase('midori').messages.put(message('m_1', '2026-08-08T09:00:00.000Z'))
    await openGroupDatabase('sakura').messages.put(message('s_1', '2026-08-08T09:00:00.000Z'))

    const all = await overviewFor(['midori', 'sakura'])
    expect(Object.keys(all).sort()).toEqual(['midori', 'sakura'])
    expect(all.midori?.unread).toBe(1)
    expect(all.sakura?.unread).toBe(1)
  })
})
