import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  closeGroupDatabase,
  deleteGroupDatabase,
  openGroupDatabase,
} from '../../src/db/group-db'
import type { OutboxItem } from '../../src/db/group-db'
import { utf8 } from '../../src/crypto/bytes'

const item: OutboxItem = {
  id: '20260807T091234Z-a1b2c3d4',
  kind: 'event',
  path: 'midori/events/20260807T091234Z-a1b2c3d4.enc',
  body: utf8('sealed'),
  queuedAt: '2026-08-07T09:12:34.000Z',
  attempts: 0,
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
  await deleteGroupDatabase('aozora')
})

describe('group database', () => {
  it('namespaces the database by group id', () => {
    expect(openGroupDatabase('midori').name).toBe('mofune_midori')
    expect(openGroupDatabase('aozora').name).toBe('mofune_aozora')
  })

  it('returns the same instance for repeated opens of one group', () => {
    expect(openGroupDatabase('midori')).toBe(openGroupDatabase('midori'))
  })

  it('keeps two groups isolated', async () => {
    await openGroupDatabase('midori').outbox.put(item)
    expect(await openGroupDatabase('aozora').outbox.count()).toBe(0)
    expect(await openGroupDatabase('midori').outbox.count()).toBe(1)
  })

  it('stores and reads back an outbox item with its body intact', async () => {
    const db = openGroupDatabase('midori')
    await db.outbox.put(item)
    const stored = await db.outbox.get(item.id)
    expect(stored?.path).toBe(item.path)
    expect(new TextDecoder().decode(stored?.body)).toBe('sealed')
  })

  it('stores messages and finds them by id', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put({
      id: 'm_1',
      scopes: ['sg_a'],
      author: 'u_tanaka',
      at: '2026-08-07T09:12:34.000Z',
      body: '来週の集まりについて',
      attachments: [],
    })
    expect((await db.messages.get('m_1'))?.body).toBe('来週の集まりについて')
  })

  it('records processed events so they are not applied twice', async () => {
    const db = openGroupDatabase('midori')
    await db.events.put({
      id: item.id,
      type: 'MESSAGE_CREATED',
      author: 'u_tanaka',
      at: '2026-08-07T09:12:34.000Z',
      payload: {},
    })
    expect(await db.events.get(item.id)).toBeDefined()
  })

  it('holds the sync cursor as a single keyed row', async () => {
    const db = openGroupDatabase('midori')
    await db.syncState.put({ key: 'cursor', value: item.id })
    await db.syncState.put({ key: 'cursor', value: 'newer' })
    expect(await db.syncState.count()).toBe(1)
    expect((await db.syncState.get('cursor'))?.value).toBe('newer')
  })

  it('deletes everything for a group when the device is unregistered', async () => {
    const db = openGroupDatabase('midori')
    await db.outbox.put(item)
    await deleteGroupDatabase('midori')
    expect(await openGroupDatabase('midori').outbox.count()).toBe(0)
  })

  it('closes without deleting the data', async () => {
    await openGroupDatabase('midori').outbox.put(item)
    await closeGroupDatabase('midori')
    expect(await openGroupDatabase('midori').outbox.count()).toBe(1)
  })
})
