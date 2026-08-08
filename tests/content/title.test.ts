import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { createPost } from '../../src/content/post'
import { openMessage } from '../../src/content/messages'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { flushOutbox } from '../../src/sync/outbox'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { messagePath } from '../../src/storage/paths'
import type { Session } from '../../src/group/session'

async function session(): Promise<Session> {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role: 'staff',
    scopes: ['all'],
    generation: 1,
    groupKeys: new Map([['all:v1', await generateAesKey()]]),
    roster: { groupId: 'midori', generation: 1, subgroups: [], members: [] },
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  } as unknown as Session
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('a post with a title', () => {
  it('carries the title through to the stored message', async () => {
    const me = await session()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()

    const result = await createPost({
      session: me,
      db,
      draft: {
        title: '来週の集まりについて',
        body: '8月14日(金)10時に集合です。',
        scopes: ['all'],
        attachments: [],
      },
    })
    await flushOutbox({ db, storage })

    const message = await openMessage(
      me.groupKeys,
      await storage.get(messagePath('midori', result.messageId)),
    )
    expect(message.title).toBe('来週の集まりについて')
    expect(message.body).toBe('8月14日(金)10時に集合です。')
  })

  it('is allowed to have no title, because older posts do not have one', async () => {
    const me = await session()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()

    const result = await createPost({
      session: me,
      db,
      draft: { title: '', body: '本文だけ', scopes: ['all'], attachments: [] },
    })
    await flushOutbox({ db, storage })

    const message = await openMessage(
      me.groupKeys,
      await storage.get(messagePath('midori', result.messageId)),
    )
    expect(message.title).toBeUndefined()
    expect(message.body).toBe('本文だけ')
  })
})

describe('the author keeps a copy of what they posted', () => {
  it('shows up in the local cache without waiting for a sync', async () => {
    const me = await session()
    const db = openGroupDatabase('midori')

    const result = await createPost({
      session: me,
      db,
      draft: {
        title: '来週の集まり',
        body: '8月14日(金)10時に集合です。',
        scopes: ['all'],
        attachments: [],
      },
    })

    const cached = await db.messages.get(result.messageId)
    expect(cached?.title).toBe('来週の集まり')
    expect(cached?.body).toBe('8月14日(金)10時に集合です。')
    expect(cached?.author).toBe('u_tanaka')
  })

  it('keeps the form, so the author can open the tally right away', async () => {
    const me = await session()
    const db = openGroupDatabase('midori')

    const result = await createPost({
      session: me,
      db,
      draft: {
        title: '',
        body: '来ますか',
        scopes: ['all'],
        attachments: [],
        form: {
          id: 'fm_1',
          kind: 'attendance',
          question: '来ますか',
          choices: ['行く', '行かない'],
          allowNote: false,
          dueAt: null,
          recipient: { userId: 'u_tanaka', ecdhPublic: 'x' },
        },
      },
    })

    expect((await db.messages.get(result.messageId))?.form?.id).toBe('fm_1')
  })
})

describe('the author keeps their own attachments too', () => {
  it('caches the bytes so the thumbnail shows before any sync', async () => {
    const me = await session()
    const db = openGroupDatabase('midori')

    const result = await createPost({
      session: me,
      db,
      draft: {
        title: '',
        body: '写真です',
        scopes: ['all'],
        attachments: [
          { name: 'a.png', mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) as never },
        ],
      },
    })

    const fileId = result.attachments[0]?.fileId as string
    const cached = await db.files.get(fileId)
    expect(cached?.mediaType).toBe('image/png')
    expect(Array.from(cached?.blob ?? [])).toEqual([1, 2, 3])
  })
})
