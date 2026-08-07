import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { enqueue, flushOutbox, pending } from '../../src/sync/outbox'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { fromUtf8, utf8 } from '../../src/crypto/bytes'
import type { StorageProvider } from '../../src/storage/provider'
import type { Bytes } from '../../src/crypto/bytes'

const draft = {
  id: '20260807T091234Z-aaaa',
  kind: 'event' as const,
  path: 'midori/events/20260807T091234Z-aaaa.enc',
  body: utf8('sealed'),
}

/**
 * put だけを差し替えたプロバイダを作る。クラスインスタンスをスプレッドしても
 * プロトタイプ上のメソッドは複製されないので、明示的に委譲する。
 */
function withPut(put: (path: string, data: Bytes) => Promise<void>): StorageProvider {
  const inner = new MemoryStorageProvider()
  return {
    capabilities: inner.capabilities,
    get: (path) => inner.get(path),
    list: (prefix, after) => inner.list(prefix, after),
    delete: (path) => inner.delete(path),
    put,
  }
}

/** put が常に失敗するプロバイダ。オフライン相当。 */
function offline(): StorageProvider {
  return withPut(() => Promise.reject(new Error('offline')))
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('outbox', () => {
  it('records the queue time and starts the attempt count at zero', async () => {
    const db = openGroupDatabase('midori')
    await enqueue(db, draft)
    const [item] = await pending(db)
    expect(item?.attempts).toBe(0)
    expect(Date.parse(item?.queuedAt ?? '')).not.toBeNaN()
  })

  it('returns pending items oldest first', async () => {
    const db = openGroupDatabase('midori')
    await enqueue(db, { ...draft, id: 'b' })
    await enqueue(db, { ...draft, id: 'a' })
    const items = await pending(db)
    expect(items).toHaveLength(2)
    expect(Date.parse(items[0]?.queuedAt ?? '')).toBeLessThanOrEqual(
      Date.parse(items[1]?.queuedAt ?? ''),
    )
  })

  it('writes queued items to storage and empties the queue', async () => {
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    await enqueue(db, draft)
    const result = await flushOutbox({ db, storage })
    expect(result).toEqual({ sent: 1, failed: 0 })
    expect(fromUtf8(await storage.get(draft.path))).toBe('sealed')
    expect(await pending(db)).toHaveLength(0)
  })

  it('keeps items in the queue when the write fails', async () => {
    const db = openGroupDatabase('midori')
    await enqueue(db, draft)
    const result = await flushOutbox({ db, storage: offline() })
    expect(result).toEqual({ sent: 0, failed: 1 })
    expect(await pending(db)).toHaveLength(1)
  })

  it('counts an attempt on each failure', async () => {
    const db = openGroupDatabase('midori')
    await enqueue(db, draft)
    await flushOutbox({ db, storage: offline() })
    await flushOutbox({ db, storage: offline() })
    expect((await pending(db))[0]?.attempts).toBe(2)
  })

  it('sends the rest of the queue even when one item fails', async () => {
    const db = openGroupDatabase('midori')
    let first = true
    // 1件目だけ失敗し、2件目は成功する
    const flaky = withPut(() => {
      if (first) {
        first = false
        return Promise.reject(new Error('flaky'))
      }
      return Promise.resolve()
    })

    await enqueue(db, { ...draft, id: 'a', path: 'midori/events/a.enc' })
    await enqueue(db, { ...draft, id: 'b', path: 'midori/events/b.enc' })
    const result = await flushOutbox({ db, storage: flaky })
    expect(result).toEqual({ sent: 1, failed: 1 })
    expect(await pending(db)).toHaveLength(1)
  })

  it('sends the item on a later flush once the network is back', async () => {
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    await enqueue(db, draft)
    await flushOutbox({ db, storage: offline() })
    const result = await flushOutbox({ db, storage })
    expect(result).toEqual({ sent: 1, failed: 0 })
    expect(await pending(db)).toHaveLength(0)
  })

  it('reports an empty queue as nothing to do', async () => {
    const db = openGroupDatabase('midori')
    expect(await flushOutbox({ db, storage: new MemoryStorageProvider() })).toEqual({
      sent: 0,
      failed: 0,
    })
  })
})
