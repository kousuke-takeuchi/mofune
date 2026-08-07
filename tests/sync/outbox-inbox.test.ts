import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openGroupDatabase, deleteGroupDatabase } from '../../src/db/group-db'
import { enqueue, flushOutbox } from '../../src/sync/outbox'
import { HttpStorageProvider } from '../../src/storage/http'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { utf8 } from '../../src/crypto/bytes'
import type { Bytes } from '../../src/crypto/bytes'

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('flushOutbox', () => {
  it('puts an inbox item to its presigned url, not through the provider', async () => {
    // 参加者は書き込み資格情報を持たない。プロバイダへ put しようとすると
    // 読み取り専用で必ず失敗し、投函が永久にキューへ残る。
    const db = openGroupDatabase('midori')
    const put = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', put)

    await enqueue(db, {
      id: 'slot_1',
      kind: 'inbox',
      path: 'https://s3.invalid/mofune/midori/inbox/u_1/abc.enc?X-Amz-Signature=x',
      body: utf8('sealed') as Bytes,
    })

    const result = await flushOutbox({
      db,
      storage: new HttpStorageProvider('https://public.invalid'),
    })

    expect(result).toEqual({ sent: 1, failed: 0 })
    expect(put).toHaveBeenCalledTimes(1)
    const [url, init] = put.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('X-Amz-Signature')
    expect(init.method).toBe('PUT')
    expect(await db.outbox.count()).toBe(0)
  })

  it('keeps an inbox item queued when the upload is refused', async () => {
    const db = openGroupDatabase('midori')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    await enqueue(db, {
      id: 'slot_1',
      kind: 'inbox',
      path: 'https://s3.invalid/mofune/x.enc?X-Amz-Signature=x',
      body: utf8('sealed') as Bytes,
    })
    const result = await flushOutbox({
      db,
      storage: new HttpStorageProvider('https://public.invalid'),
    })
    expect(result).toEqual({ sent: 0, failed: 1 })
    expect(await db.outbox.count()).toBe(1)
  })

  it('still sends ordinary objects through the provider', async () => {
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    await enqueue(db, {
      id: 'm_1',
      kind: 'object',
      path: 'midori/messages/m_1.enc',
      body: utf8('sealed') as Bytes,
    })
    const result = await flushOutbox({ db, storage })
    expect(result).toEqual({ sent: 1, failed: 0 })
    expect(await storage.get('midori/messages/m_1.enc')).toBeDefined()
  })
})
