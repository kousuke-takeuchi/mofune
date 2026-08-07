import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { openGroupDatabase, deleteGroupDatabase } from '../../src/db/group-db'
import { readLastSyncedAt, syncGroup } from '../../src/sync/sync'
import { MemoryStorageProvider } from '../../src/storage/memory'

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('last synced at', () => {
  it('is unknown before the first sync', async () => {
    expect(await readLastSyncedAt(openGroupDatabase('midori'))).toBeNull()
  })

  it('is recorded even when there was nothing new to apply', async () => {
    // 「同期した」と「新着があった」は別。何も無かった同期も記録しないと、
    // 設定画面の「最後に同期した時刻」が古いままで不安にさせる。
    const db = openGroupDatabase('midori')
    await syncGroup({
      storage: new MemoryStorageProvider(),
      groupId: 'midori',
      keys: new Map(),
      db,
    })
    const at = await readLastSyncedAt(db)
    expect(at).not.toBeNull()
    expect(Number.isNaN(Date.parse(at as string))).toBe(false)
  })
})
