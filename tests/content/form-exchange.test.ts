import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { collectFormResponses, sendFormResponse } from '../../src/content/form-exchange'
import { buildForm } from '../../src/content/forms'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { flushOutbox } from '../../src/sync/outbox'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { toBase64 } from '../../src/crypto/bytes'
import type { Bytes } from '../../src/crypto/bytes'
import type { RawKeyPair } from '../../src/crypto/asymmetric'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

async function world(): Promise<{
  author: Session
  other: Session
  responder: Session
  authorKeys: RawKeyPair
}> {
  const authorKeys = await generateEcdhKeyPair()
  const otherKeys = await generateEcdhKeyPair()
  const responderKeys = await generateEcdhKeyPair()

  const roster: RosterContents = {
    groupId: 'midori',
    generation: 1,
    subgroups: [],
    members: [
      {
        userId: 'u_author',
        displayName: '田中 みか',
        role: 'staff',
        scopes: [],
        ecdhPublic: toBase64(authorKeys.publicKey),
        ecdsaPublic: '',
      },
      {
        userId: 'u_other',
        displayName: '渡辺 けい',
        role: 'admin',
        scopes: [],
        ecdhPublic: toBase64(otherKeys.publicKey),
        ecdsaPublic: '',
      },
      {
        userId: 'u_sato',
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: [],
        ecdhPublic: toBase64(responderKeys.publicKey),
        ecdsaPublic: '',
      },
    ],
  }

  const make = (userId: string, displayName: string, keys: RawKeyPair): Session =>
    ({
      groupId: 'midori',
      groupName: 'みどり台',
      userId,
      displayName,
      role: userId === 'u_sato' ? 'member' : 'staff',
      scopes: [],
      groupKeys: new Map(),
      generation: 1,
      roster,
      ecdhPrivate: keys.privateKey,
      ecdsaPrivate: new Uint8Array(0) as Bytes,
    }) as unknown as Session

  return {
    author: make('u_author', '田中 みか', authorKeys),
    other: make('u_other', '渡辺 けい', otherKeys),
    responder: make('u_sato', '佐藤 さくら', responderKeys),
    authorKeys,
  }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendFormResponse', () => {
  it('seals the answer so only the person who asked can open it', async () => {
    const { author, other, responder } = await world()
    const form = buildForm({
      session: author,
      question: '参加できますか?',
      choices: ['参加します', '欠席します'],
      allowNote: true,
      dueAt: null,
    })
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()

    await sendFormResponse({
      session: responder,
      db,
      storage,
      form,
      messageId: 'm_1',
      choice: '参加します',
      note: '送迎の相談をしたいです',
    })
    await flushOutbox({ db, storage })

    // ほかの担当者には1件も見えない
    expect((await collectFormResponses({ session: other, storage, db })).collected).toBe(0)

    const mine = await collectFormResponses({ session: author, storage, db })
    expect(mine.collected).toBe(1)
    const stored = await db.formResponses.toArray()
    expect(stored[0]).toMatchObject({
      formId: form.id,
      userId: 'u_sato',
      displayName: '佐藤 さくら',
      choice: '参加します',
      note: '送迎の相談をしたいです',
    })
  })

  it('leaves an answer alone when someone else looks in the inbox', async () => {
    const { author, other, responder } = await world()
    const form = buildForm({
      session: author,
      question: 'q',
      choices: ['はい', 'いいえ'],
      allowNote: false,
      dueAt: null,
    })
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    await sendFormResponse({
      session: responder,
      db,
      storage,
      form,
      messageId: 'm_1',
      choice: 'はい',
      note: '',
    })
    await flushOutbox({ db, storage })

    await collectFormResponses({ session: other, storage, db })
    // 消されていないので作成者はあとから拾える
    expect((await collectFormResponses({ session: author, storage, db })).collected).toBe(1)
  })

  it('replaces an earlier answer from the same person', async () => {
    const { author, responder } = await world()
    const form = buildForm({
      session: author,
      question: 'q',
      choices: ['はい', 'いいえ'],
      allowNote: false,
      dueAt: null,
    })
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()

    for (const choice of ['はい', 'いいえ']) {
      await sendFormResponse({
        session: responder,
        db,
        storage,
        form,
        messageId: 'm_1',
        choice,
        note: '',
      })
      await flushOutbox({ db, storage })
    }

    await collectFormResponses({ session: author, storage, db })
    const stored = await db.formResponses.toArray()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.choice).toBe('いいえ')
  })

  it('clears the answer out of the inbox once it is kept', async () => {
    const { author, responder } = await world()
    const form = buildForm({
      session: author,
      question: 'q',
      choices: ['はい', 'いいえ'],
      allowNote: false,
      dueAt: null,
    })
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    await sendFormResponse({
      session: responder,
      db,
      storage,
      form,
      messageId: 'm_1',
      choice: 'はい',
      note: '',
    })
    await flushOutbox({ db, storage })

    await collectFormResponses({ session: author, storage, db })
    expect((await collectFormResponses({ session: author, storage, db })).collected).toBe(0)
  })
})
