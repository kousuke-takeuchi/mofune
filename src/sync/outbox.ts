import type { GroupDatabase, OutboxItem } from '../db/group-db'
import type { StorageProvider } from '../storage/provider'

export interface FlushResult {
  sent: number
  failed: number
}

export async function enqueue(
  db: GroupDatabase,
  item: Omit<OutboxItem, 'queuedAt' | 'attempts'>,
): Promise<void> {
  await db.outbox.put({ ...item, queuedAt: new Date().toISOString(), attempts: 0 })
}

export async function pending(db: GroupDatabase): Promise<OutboxItem[]> {
  return db.outbox.orderBy('queuedAt').toArray()
}

/**
 * 溜まっている投稿をストレージへ送る。1件の失敗で以降を止めず、
 * 失敗した項目はキューに残して attempts を増やす(次回の再送で拾う)。
 */
export async function flushOutbox(options: {
  db: GroupDatabase
  storage: StorageProvider
}): Promise<FlushResult> {
  let sent = 0
  let failed = 0
  for (const item of await pending(options.db)) {
    try {
      await options.storage.put(item.path, item.body)
      await options.db.outbox.delete(item.id)
      sent += 1
    } catch {
      await options.db.outbox.put({ ...item, attempts: item.attempts + 1 })
      failed += 1
    }
  }
  return { sent, failed }
}
