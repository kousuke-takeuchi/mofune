import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { countUnread, countUnreadFor } from '../../src/db/unread'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import type { CachedMessage } from '../../src/db/group-db'

function message(id: string, at: string): CachedMessage {
  return { id, scopes: ['all'], author: 'u_1', at, body: id, attachments: [] }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
  await deleteGroupDatabase('sakura')
})

describe('countUnread', () => {
  it('counts everything before anything has been read', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([
      message('m_1', '2026-08-05T00:00:00.000Z'),
      message('m_2', '2026-08-07T00:00:00.000Z'),
    ])
    expect(await countUnread('midori')).toBe(2)
  })

  it('counts only what arrived after the last read', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([
      message('m_1', '2026-08-05T00:00:00.000Z'),
      message('m_2', '2026-08-07T00:00:00.000Z'),
    ])
    await db.syncState.put({ key: 'lastReadAt', value: '2026-08-06T00:00:00.000Z' })
    expect(await countUnread('midori')).toBe(1)
  })

  it('is zero for a group this device has never opened', async () => {
    expect(await countUnread('never-seen')).toBe(0)
  })

  it('counts each group on its own', async () => {
    await openGroupDatabase('midori').messages.put(message('m_1', '2026-08-05T00:00:00.000Z'))
    await openGroupDatabase('sakura').messages.bulkPut([
      message('m_2', '2026-08-05T00:00:00.000Z'),
      message('m_3', '2026-08-06T00:00:00.000Z'),
    ])
    expect(await countUnreadFor(['midori', 'sakura'])).toEqual({ midori: 1, sakura: 2 })
  })
})
