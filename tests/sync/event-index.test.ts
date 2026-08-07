import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  eventIndexPath,
  listEventIds,
  rebuildEventIndex,
} from '../../src/sync/event-index'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { HttpStorageProvider } from '../../src/storage/http'
import { utf8 } from '../../src/crypto/bytes'
import type { Bytes } from '../../src/crypto/bytes'

const ROOT = 'https://public.invalid'

function bytes(text: string): Bytes {
  return utf8(text)
}

async function withEvents(): Promise<MemoryStorageProvider> {
  const storage = new MemoryStorageProvider()
  await storage.put('midori/events/20260807T090000Z-aaaa.enc', bytes('a'))
  await storage.put('midori/events/20260807T100000Z-bbbb.enc', bytes('b'))
  return storage
}

/** 公開読みの参加者と同じく、GET しかできない状態を作る。 */
function routeFetchTo(storage: MemoryStorageProvider): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.startsWith(`${ROOT}/`)) return new Response(null, { status: 404 })
      try {
        return new Response(await storage.get(url.slice(ROOT.length + 1)))
      } catch {
        return new Response(null, { status: 404 })
      }
    }),
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('event index', () => {
  it('lives outside events/ so it is not counted as one', () => {
    expect(eventIndexPath('midori')).toBe('midori/events-index.json')
  })

  it('is built from what is actually in the bucket', async () => {
    const storage = await withEvents()
    await rebuildEventIndex({ storage, groupId: 'midori' })
    const ids = await listEventIds({ storage, groupId: 'midori' })
    expect(ids).toEqual(['20260807T090000Z-aaaa', '20260807T100000Z-bbbb'])
  })

  it('never indexes itself', async () => {
    const storage = await withEvents()
    await rebuildEventIndex({ storage, groupId: 'midori' })
    await rebuildEventIndex({ storage, groupId: 'midori' })
    const ids = await listEventIds({ storage, groupId: 'midori' })
    expect(ids.some((id) => id.includes('index'))).toBe(false)
  })

  it('lets a read-only participant enumerate events', async () => {
    // ここが要点。公開読みのプロバイダは list ができないので、
    // 索引が無いと参加者は1件も取得できない。
    const source = await withEvents()
    await rebuildEventIndex({ storage: source, groupId: 'midori' })
    routeFetchTo(source)

    const ids = await listEventIds({
      storage: new HttpStorageProvider(ROOT),
      groupId: 'midori',
    })
    expect(ids).toEqual(['20260807T090000Z-aaaa', '20260807T100000Z-bbbb'])
  })

  it('reports nothing rather than failing when no index has been written', async () => {
    routeFetchTo(new MemoryStorageProvider())
    const ids = await listEventIds({
      storage: new HttpStorageProvider(ROOT),
      groupId: 'midori',
    })
    expect(ids).toEqual([])
  })

  it('prefers a real listing when the provider can list', async () => {
    // 担当者は資格情報を持つので、索引が古くても実物から取れる。
    const storage = await withEvents()
    await rebuildEventIndex({ storage, groupId: 'midori' })
    await storage.put('midori/events/20260807T110000Z-cccc.enc', bytes('c'))
    const ids = await listEventIds({ storage, groupId: 'midori' })
    expect(ids).toHaveLength(3)
  })
})
