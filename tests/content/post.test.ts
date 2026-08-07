import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { PostError, createPost, resolveTargets } from '../../src/content/post'
import type { Draft } from '../../src/content/post'
import { openMessage } from '../../src/content/messages'
import { openAttachment } from '../../src/content/attachments'
import { openEvent } from '../../src/sync/events'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { flushOutbox, pending } from '../../src/sync/outbox'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

const roster: RosterContents = { groupId: 'midori', generation: 1, subgroups: [], members: [] }

async function staffSession(): Promise<Session> {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role: 'staff',
    scopes: ['all', 'staff', 'sg_a', 'sg_a_pickup'],
    groupKeys: new Map([
      ['all:v1', await generateAesKey()],
      ['staff:v1', await generateAesKey()],
      ['sg_a:v1', await generateAesKey()],
      ['sg_a_pickup:v1', await generateAesKey()],
    ]),
    roster,
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
}

const draft: Draft = {
  body: '来週の集まりについて',
  scopes: ['sg_a', 'sg_a_pickup'],
  attachments: [{ name: '案内図.png', mediaType: 'image/png', bytes: utf8('png-bytes') }],
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('resolveTargets', () => {
  it('resolves scope names to the key ids the session actually holds', async () => {
    const session = await staffSession()
    expect(resolveTargets(session, ['sg_a', 'sg_a_pickup']).map((t) => t.keyId)).toEqual([
      'sg_a:v1',
      'sg_a_pickup:v1',
    ])
  })

  it('refuses a scope the session has no key for', async () => {
    const session = await staffSession()
    expect(() => resolveTargets(session, ['sg_b'])).toThrow(PostError)
  })

  it('refuses an empty scope list', async () => {
    const session = await staffSession()
    expect(() => resolveTargets(session, [])).toThrow(PostError)
  })

  it('deduplicates repeated scopes', async () => {
    const session = await staffSession()
    expect(resolveTargets(session, ['sg_a', 'sg_a']).map((t) => t.keyId)).toEqual(['sg_a:v1'])
  })
})

describe('createPost', () => {
  it('queues the attachment, the message and the event in that order', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const result = await createPost({ session, db, draft })
    const queued = await pending(db)
    expect(queued).toHaveLength(3)
    expect(queued[0]?.path).toBe(`midori/files/${result.attachments[0]?.fileId}.enc`)
    expect(queued[1]?.path).toBe(`midori/messages/${result.messageId}.enc`)
    expect(queued[2]?.path).toBe(`midori/events/${result.eventId}.enc`)
  })

  it('writes nothing to storage until the outbox is flushed', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    await createPost({ session, db, draft })
    expect(await storage.list('midori/')).toHaveLength(0)
    await flushOutbox({ db, storage })
    expect(await storage.list('midori/')).toHaveLength(3)
  })

  it('produces a message readable by a member of either addressed scope', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    const result = await createPost({ session, db, draft })
    await flushOutbox({ db, storage })

    const teamOnly = new Map([['sg_a:v1', session.groupKeys.get('sg_a:v1') as CryptoKey]])
    const message = await openMessage(
      teamOnly,
      await storage.get(`midori/messages/${result.messageId}.enc`),
    )
    expect(message.body).toBe('来週の集まりについて')
    expect(message.author).toBe('u_tanaka')
    expect(message.scopes).toEqual(['sg_a', 'sg_a_pickup'])
  })

  it('produces an attachment readable with the same keys', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    const result = await createPost({ session, db, draft })
    await flushOutbox({ db, storage })

    const keys = new Map([['sg_a:v1', session.groupKeys.get('sg_a:v1') as CryptoKey]])
    const opened = await openAttachment(
      keys,
      await storage.get(`midori/files/${result.attachments[0]?.fileId}.enc`),
    )
    expect(opened.name).toBe('案内図.png')
  })

  it('emits a MESSAGE_CREATED event that points at the message', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    const result = await createPost({ session, db, draft })
    await flushOutbox({ db, storage })

    const keys = new Map([['sg_a:v1', session.groupKeys.get('sg_a:v1') as CryptoKey]])
    const event = await openEvent(keys, await storage.get(`midori/events/${result.eventId}.enc`))
    expect(event.type).toBe('MESSAGE_CREATED')
    expect(event.author).toBe('u_tanaka')
    expect(event.payload['messageId']).toBe(result.messageId)
  })

  it('keeps the event small by not embedding the body', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    const result = await createPost({ session, db, draft })
    await flushOutbox({ db, storage })
    const event = await storage.get(`midori/events/${result.eventId}.enc`)
    const message = await storage.get(`midori/messages/${result.messageId}.enc`)
    expect(event.length).toBeLessThan(message.length)
  })

  it('is not readable by a scope that was not addressed', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    const result = await createPost({ session, db, draft })
    await flushOutbox({ db, storage })

    const outsider = new Map([['all:v1', session.groupKeys.get('all:v1') as CryptoKey]])
    await expect(
      openMessage(outsider, await storage.get(`midori/messages/${result.messageId}.enc`)),
    ).rejects.toThrow()
  })

  it('posts without attachments', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const result = await createPost({
      session,
      db,
      draft: { ...draft, attachments: [] },
    })
    expect(result.attachments).toEqual([])
    expect(await pending(db)).toHaveLength(2)
  })

  it('refuses to post as a member', async () => {
    const session = { ...(await staffSession()), role: 'member' as const }
    const db = openGroupDatabase('midori')
    await expect(createPost({ session, db, draft })).rejects.toThrow(PostError)
  })

  it('refuses an empty body with no attachments', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    await expect(
      createPost({ session, db, draft: { body: '   ', scopes: ['sg_a'], attachments: [] } }),
    ).rejects.toThrow(PostError)
  })

  it('stamps the message and the event with the same time', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    const now = new Date('2026-08-07T09:12:34.000Z')
    const result = await createPost({ session, db, draft, now })
    await flushOutbox({ db, storage })
    const keys = new Map([['sg_a:v1', session.groupKeys.get('sg_a:v1') as CryptoKey]])
    const message = await openMessage(
      keys,
      await storage.get(`midori/messages/${result.messageId}.enc`),
    )
    const event = await openEvent(keys, await storage.get(`midori/events/${result.eventId}.enc`))
    expect(message.at).toBe('2026-08-07T09:12:34.000Z')
    expect(event.at).toBe('2026-08-07T09:12:34.000Z')
  })
})
