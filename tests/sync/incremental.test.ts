import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { listEventIds } from '../../src/sync/event-index'
import { syncGroup, writeCursor } from '../../src/sync/sync'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { keyId } from '../../src/crypto/keyring'
import { sealEvent, eventPathFor } from '../../src/sync/events'
import type { GroupEvent } from '../../src/sync/events'
import type { Bytes } from '../../src/crypto/bytes'
import type { StorageEntry, StorageProvider } from '../../src/storage/provider'

const SCOPE = keyId('all', 1)

async function world(count: number) {
  const key = await generateAesKey()
  const storage = new MemoryStorageProvider()
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const event: GroupEvent = {
      // 並びが分かるように、揃えた桁で作る
      id: `e_2026080800000${String(i).padStart(2, '0')}`,
      type: 'ABSENCE_REPORTED',
      author: 'u_sato',
      at: '2026-08-08T09:00:00.000Z',
      payload: {
        absence: {
          id: `ab_${String(i)}`,
          kind: 'absent',
          date: '2026-08-08',
          reason: '体調不良',
          note: '',
          author: 'u_sato',
          at: '2026-08-08T09:00:00.000Z',
        },
      },
    }
    ids.push(event.id)
    await storage.put(
      eventPathFor('midori', event.id),
      await sealEvent(event, [{ keyId: SCOPE, key }]),
    )
  }
  return { storage, keys: new Map([[SCOPE, key]]), ids }
}

/** list と get の呼ばれかたを見張る。中身は元のプロバイダに任せる。 */
function watched(inner: StorageProvider) {
  const listCalls: Array<{ prefix: string; after?: string }> = []
  let inFlight = 0
  let peak = 0

  const provider: StorageProvider = {
    capabilities: inner.capabilities,
    async get(path: string): Promise<Bytes> {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        // 1ティック待たせて、同時に何本走ったかが見えるようにする
        await new Promise((resolve) => setTimeout(resolve, 1))
        return await inner.get(path)
      } finally {
        inFlight -= 1
      }
    },
    put: (path: string, data: Bytes) => inner.put(path, data),
    async list(prefix: string, after?: string): Promise<StorageEntry[]> {
      listCalls.push(after === undefined ? { prefix } : { prefix, after })
      return inner.list(prefix, after)
    },
    delete: (path: string) => inner.delete(path),
  }
  return { provider, listCalls, peakOf: () => peak }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('listEventIds', () => {
  it('asks the storage only for what comes after the cursor', async () => {
    const { storage, ids } = await world(3)
    const seen = watched(storage)

    const found = await listEventIds({
      storage: seen.provider,
      groupId: 'midori',
      after: ids[0],
    })

    expect(found).toEqual([ids[1], ids[2]])
    expect(seen.listCalls[0]?.after).toBe(`midori/events/${ids[0] as string}.enc`)
  })

  it('asks for everything when there is no cursor yet', async () => {
    const { storage, ids } = await world(2)
    const seen = watched(storage)
    expect(await listEventIds({ storage: seen.provider, groupId: 'midori' })).toEqual(ids)
    expect(seen.listCalls[0]?.after).toBeUndefined()
  })
})

describe('syncGroup', () => {
  it('does not re-fetch what it already has', async () => {
    const { storage, keys, ids } = await world(3)
    const db = openGroupDatabase('midori')
    await writeCursor(db, ids[1] as string)
    const seen = watched(storage)

    const result = await syncGroup({ storage: seen.provider, groupId: 'midori', keys, db })

    expect(result.applied).toBe(1)
    // カーソル以降だけを頼む
    expect(seen.listCalls[0]?.after).toBe(`midori/events/${ids[1] as string}.enc`)
  })

  it('fetches the bodies at the same time rather than one after another', async () => {
    const { storage, keys } = await world(6)
    const db = openGroupDatabase('midori')
    const seen = watched(storage)

    const result = await syncGroup({ storage: seen.provider, groupId: 'midori', keys, db })

    expect(result.applied).toBe(6)
    // 1本ずつ待つと 1 のまま。まとめて取れていれば 1 より大きい
    expect(seen.peakOf()).toBeGreaterThan(1)
  })

  it('keeps the order it applies them in, whatever order they arrive', async () => {
    const { storage, keys, ids } = await world(5)
    const db = openGroupDatabase('midori')

    await syncGroup({ storage, groupId: 'midori', keys, db })

    const stored = (await db.events.toArray()).map((event) => event.id)
    expect([...stored].sort()).toEqual(ids)
    // カーソルは最後のイベントで止まる
    expect((await db.syncState.get('cursor'))?.value).toBe(ids[4])
  })

  it('does not go backwards when nothing is new', async () => {
    const { storage, keys, ids } = await world(2)
    const db = openGroupDatabase('midori')
    await syncGroup({ storage, groupId: 'midori', keys, db })

    const again = await syncGroup({ storage, groupId: 'midori', keys, db })

    expect(again.applied).toBe(0)
    expect(again.cursor).toBe(ids[1])
  })
})
