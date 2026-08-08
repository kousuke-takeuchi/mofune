import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { projectEvent } from '../../src/sync/projection'
import { createPost } from '../../src/content/post'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { flushOutbox } from '../../src/sync/outbox'
import { openEvent } from '../../src/sync/events'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { fromUtf8, utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { GroupEvent } from '../../src/sync/events'
import type { RosterContents } from '../../src/crypto/roster'

const roster: RosterContents = { groupId: 'midori', generation: 1, subgroups: [], members: [] }

async function staffSession(): Promise<Session> {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role: 'staff',
    scopes: ['sg_a'],
    groupKeys: new Map([['sg_a:v1', await generateAesKey()]]),
    generation: 1,
    roster,
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
}

/** 投稿を1件作り、ストレージへ送り、そのイベントを返す。 */
async function postedEvent(): Promise<{
  session: Session
  storage: MemoryStorageProvider
  event: GroupEvent
  messageId: string
  fileId: string
}> {
  const session = await staffSession()
  const db = openGroupDatabase('midori')
  const storage = new MemoryStorageProvider()
  const result = await createPost({
    session,
    db,
    draft: {
      body: '来週の集まりについて',
      scopes: ['sg_a'],
      attachments: [{ name: '案内図.png', mediaType: 'image/png', bytes: utf8('png-bytes') }],
    },
  })
  await flushOutbox({ db, storage })
  const event = await openEvent(
    session.groupKeys,
    await storage.get(`midori/events/${result.eventId}.enc`),
  )
  return {
    session,
    storage,
    event,
    messageId: result.messageId,
    fileId: result.attachments[0]?.fileId as string,
  }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('projectEvent', () => {
  it('writes the message into the local cache', async () => {
    const { session, storage, event, messageId } = await postedEvent()
    const db = openGroupDatabase('midori')
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event,
    })
    expect(result.messages).toBe(1)
    const cached = await db.messages.get(messageId)
    expect(cached?.body).toBe('来週の集まりについて')
    expect(cached?.author).toBe('u_tanaka')
    expect(cached?.scopes).toEqual(['sg_a'])
  })

  it('writes the attachment bytes into the local cache', async () => {
    const { session, storage, event, fileId } = await postedEvent()
    const db = openGroupDatabase('midori')
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event,
    })
    expect(result.files).toBe(1)
    const cached = await db.files.get(fileId)
    expect(cached?.mediaType).toBe('image/png')
    expect(fromUtf8(cached?.blob as never)).toBe('png-bytes')
  })

  it('links the message to its attachment ids', async () => {
    const { session, storage, event, messageId, fileId } = await postedEvent()
    const db = openGroupDatabase('midori')
    await projectEvent({ db, storage, groupId: 'midori', keys: session.groupKeys, event })
    expect((await db.messages.get(messageId))?.attachments).toEqual([fileId])
  })

  it('is idempotent when the same event is projected twice', async () => {
    const { session, storage, event } = await postedEvent()
    const db = openGroupDatabase('midori')
    await projectEvent({ db, storage, groupId: 'midori', keys: session.groupKeys, event })
    await projectEvent({ db, storage, groupId: 'midori', keys: session.groupKeys, event })
    expect(await db.messages.count()).toBe(1)
    expect(await db.files.count()).toBe(1)
  })

  it('reports a missing message body instead of throwing', async () => {
    const { session, storage, event, messageId } = await postedEvent()
    await storage.delete(`midori/messages/${messageId}.enc`)
    const db = openGroupDatabase('midori')
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event,
    })
    expect(result.missing).toBe(1)
    expect(await db.messages.count()).toBe(0)
  })

  it('still caches the message when an attachment has not arrived yet', async () => {
    const { session, storage, event, messageId, fileId } = await postedEvent()
    await storage.delete(`midori/files/${fileId}.enc`)
    const db = openGroupDatabase('midori')
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event,
    })
    expect(result.messages).toBe(1)
    expect(result.missing).toBe(1)
    expect(await db.messages.get(messageId)).toBeDefined()
    expect(await db.files.get(fileId)).toBeUndefined()
  })

  it('ignores an event type it does not project', async () => {
    const { session, storage } = await postedEvent()
    const db = openGroupDatabase('midori')
    const other: GroupEvent = {
      id: '20260807T091234Z-aaaa',
      type: 'MEMBER_UPDATED',
      author: 'u_admin',
      at: '2026-08-07T09:12:34.000Z',
      payload: {},
    }
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event: other,
    })
    expect(result).toEqual({ messages: 0, files: 0, absences: 0, missing: 0 })
  })

  it('reports a MESSAGE_CREATED event with no messageId as missing', async () => {
    const { session, storage } = await postedEvent()
    const db = openGroupDatabase('midori')
    const broken: GroupEvent = {
      id: '20260807T091234Z-bbbb',
      type: 'MESSAGE_CREATED',
      author: 'u_tanaka',
      at: '2026-08-07T09:12:34.000Z',
      payload: {},
    }
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event: broken,
    })
    expect(result.missing).toBe(1)
  })
  it('projects an absence event into the absences table', async () => {
    const { session, storage } = await postedEvent()
    const db = openGroupDatabase('midori')
    const event: GroupEvent = {
      id: '20260808T073000Z-aaaa',
      type: 'ABSENCE_REPORTED',
      author: 'u_tanaka',
      at: '2026-08-08T07:30:00.000Z',
      payload: {
        absence: {
          id: 'ab_1',
          kind: 'absent',
          date: '2026-08-08',
          reason: '体調不良',
          note: '朝から熱があります',
          author: 'u_sato',
          at: '2026-08-08T07:30:00.000Z',
        },
      },
    }
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event,
    })
    expect(result.absences).toBe(1)
    expect((await db.absences.get('ab_1'))?.note).toBe('朝から熱があります')
  })

  it('is idempotent for absence events', async () => {
    const { session, storage } = await postedEvent()
    const db = openGroupDatabase('midori')
    const event: GroupEvent = {
      id: '20260808T073000Z-bbbb',
      type: 'ABSENCE_REPORTED',
      author: 'u_tanaka',
      at: '2026-08-08T07:30:00.000Z',
      payload: {
        absence: {
          id: 'ab_2',
          kind: 'late',
          date: '2026-08-08',
          reason: '',
          note: '',
          author: 'u_sato',
          at: '2026-08-08T07:30:00.000Z',
        },
      },
    }
    await projectEvent({ db, storage, groupId: 'midori', keys: session.groupKeys, event })
    await projectEvent({ db, storage, groupId: 'midori', keys: session.groupKeys, event })
    expect(await db.absences.count()).toBe(1)
  })

  it('reports an absence event with no payload as missing', async () => {
    const { session, storage } = await postedEvent()
    const db = openGroupDatabase('midori')
    const event: GroupEvent = {
      id: '20260808T073000Z-cccc',
      type: 'ABSENCE_REPORTED',
      author: 'u_tanaka',
      at: '2026-08-08T07:30:00.000Z',
      payload: {},
    }
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event,
    })
    expect(result.missing).toBe(1)
    expect(await db.absences.count()).toBe(0)
  })
})
