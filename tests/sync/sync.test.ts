import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { readCursor, syncGroup, writeCursor } from '../../src/sync/sync'
import { eventPathFor, sealEvent } from '../../src/sync/events'
import type { GroupEvent } from '../../src/sync/events'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'

const teamKeyId = 'sg_a:v1'
const otherKeyId = 'sg_b:v1'

function eventAt(id: string, author = 'u_tanaka'): GroupEvent {
  return {
    id,
    type: 'MESSAGE_CREATED',
    author,
    at: '2026-08-07T09:12:34.000Z',
    payload: { messageId: `m_${id}` },
  }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('cursor', () => {
  it('is null before the first sync', async () => {
    expect(await readCursor(openGroupDatabase('midori'))).toBeNull()
  })

  it('round-trips', async () => {
    const db = openGroupDatabase('midori')
    await writeCursor(db, '20260807T091234Z-aaaa')
    expect(await readCursor(db)).toBe('20260807T091234Z-aaaa')
  })
})

describe('syncGroup', () => {
  it('applies every event on a first sync', async () => {
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    for (const id of ['20260807T091234Z-aaaa', '20260807T091300Z-bbbb']) {
      await storage.put(eventPathFor('midori', id), await sealEvent(eventAt(id), [{ keyId: teamKeyId, key }]))
    }
    const db = openGroupDatabase('midori')
    const result = await syncGroup({
      storage,
      groupId: 'midori',
      keys: new Map([[teamKeyId, key]]),
      db,
    })
    expect(result.applied).toBe(2)
    expect(await db.events.count()).toBe(2)
  })

  it('advances the cursor to the newest event it saw', async () => {
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    for (const id of ['20260807T091234Z-aaaa', '20260807T091300Z-bbbb']) {
      await storage.put(eventPathFor('midori', id), await sealEvent(eventAt(id), [{ keyId: teamKeyId, key }]))
    }
    const db = openGroupDatabase('midori')
    const result = await syncGroup({
      storage,
      groupId: 'midori',
      keys: new Map([[teamKeyId, key]]),
      db,
    })
    expect(result.cursor).toBe('20260807T091300Z-bbbb')
    expect(await readCursor(db)).toBe('20260807T091300Z-bbbb')
  })

  it('applies nothing on a second sync with no new events', async () => {
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    const id = '20260807T091234Z-aaaa'
    await storage.put(eventPathFor('midori', id), await sealEvent(eventAt(id), [{ keyId: teamKeyId, key }]))
    const db = openGroupDatabase('midori')
    const keys = new Map([[teamKeyId, key]])
    await syncGroup({ storage, groupId: 'midori', keys, db })
    const second = await syncGroup({ storage, groupId: 'midori', keys, db })
    expect(second.applied).toBe(0)
  })

  it('applies only the events newer than the cursor', async () => {
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    const keys = new Map([[teamKeyId, key]])
    const db = openGroupDatabase('midori')
    const first = '20260807T091234Z-aaaa'
    await storage.put(eventPathFor('midori', first), await sealEvent(eventAt(first), [{ keyId: teamKeyId, key }]))
    await syncGroup({ storage, groupId: 'midori', keys, db })

    const second = '20260807T091300Z-bbbb'
    await storage.put(eventPathFor('midori', second), await sealEvent(eventAt(second), [{ keyId: teamKeyId, key }]))
    const result = await syncGroup({ storage, groupId: 'midori', keys, db })
    expect(result.applied).toBe(1)
    expect(result.cursor).toBe(second)
  })

  it('skips events addressed to a scope the user is not in, and still advances', async () => {
    const storage = new MemoryStorageProvider()
    const mine = await generateAesKey()
    const theirs = await generateAesKey()
    const visible = '20260807T091234Z-aaaa'
    const hidden = '20260807T091300Z-bbbb'
    await storage.put(eventPathFor('midori', visible), await sealEvent(eventAt(visible), [{ keyId: teamKeyId, key: mine }]))
    await storage.put(eventPathFor('midori', hidden), await sealEvent(eventAt(hidden), [{ keyId: otherKeyId, key: theirs }]))

    const db = openGroupDatabase('midori')
    const result = await syncGroup({
      storage,
      groupId: 'midori',
      keys: new Map([[teamKeyId, mine]]),
      db,
    })
    expect(result.applied).toBe(1)
    expect(result.skipped).toBe(1)
    // カーソルを進めないと、この端末は永久に同じ位置で止まる
    expect(result.cursor).toBe(hidden)
  })

  it('applies events in chronological order regardless of listing order', async () => {
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    const ids = ['20260807T091300Z-bbbb', '20260806T235959Z-aaaa', '20260807T091234Z-cccc']
    for (const id of ids) {
      await storage.put(eventPathFor('midori', id), await sealEvent(eventAt(id), [{ keyId: teamKeyId, key }]))
    }
    const db = openGroupDatabase('midori')
    await syncGroup({ storage, groupId: 'midori', keys: new Map([[teamKeyId, key]]), db })
    const stored = await db.events.toArray()
    expect(stored.map((event) => event.id)).toEqual([...ids].sort())
  })

  it('is idempotent when the same event is seen twice', async () => {
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    const id = '20260807T091234Z-aaaa'
    await storage.put(eventPathFor('midori', id), await sealEvent(eventAt(id), [{ keyId: teamKeyId, key }]))
    const db = openGroupDatabase('midori')
    const keys = new Map([[teamKeyId, key]])
    await syncGroup({ storage, groupId: 'midori', keys, db })
    await writeCursor(db, '')
    await syncGroup({ storage, groupId: 'midori', keys, db })
    expect(await db.events.count()).toBe(1)
  })

  it('leaves the cursor alone when there is nothing to sync', async () => {
    const db = openGroupDatabase('midori')
    const result = await syncGroup({
      storage: new MemoryStorageProvider(),
      groupId: 'midori',
      keys: new Map(),
      db,
    })
    expect(result).toEqual({ applied: 0, skipped: 0, missing: 0, cursor: null })
  })
  it('projects the messages it applies into the local cache', async () => {
    const { createPost } = await import('../../src/content/post')
    const { openGroupDatabase } = await import('../../src/db/group-db')
    const { flushOutbox } = await import('../../src/sync/outbox')
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    const session = {
      groupId: 'midori',
      groupName: 'みどり台グループ',
      userId: 'u_tanaka',
      displayName: '田中 みか',
      role: 'staff' as const,
      scopes: ['sg_a'],
      groupKeys: new Map([['sg_a:v1', key]]),
      generation: 1,
      roster: { groupId: 'midori', generation: 1, subgroups: [], members: [] },
      ecdhPrivate: new Uint8Array(0),
      ecdsaPrivate: new Uint8Array(0),
    }
    const authorDb = openGroupDatabase('midori')
    const result = await createPost({
      session,
      db: authorDb,
      draft: { body: 'こんにちは', scopes: ['sg_a'], attachments: [] },
    })
    await flushOutbox({ db: authorDb, storage })
    await deleteGroupDatabase('midori')

    const readerDb = openGroupDatabase('midori')
    const synced = await syncGroup({
      storage,
      groupId: 'midori',
      keys: new Map([['sg_a:v1', key]]),
      db: readerDb,
    })
    expect(synced.applied).toBe(1)
    expect((await readerDb.messages.get(result.messageId))?.body).toBe('こんにちは')
  })
})
