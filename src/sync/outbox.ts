import { toBase64 } from '../crypto/bytes'
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
 * 1件を送る。
 *
 * 上りの投函先は presigned URL なので、プロバイダを通さず素の PUT で送る。
 * 参加者が持つのは公開読み専用のプロバイダで、そこへ put すると必ず失敗し、
 * 投函が永久にキューへ残る。
 */
async function send(storage: StorageProvider, item: OutboxItem): Promise<void> {
  if (item.kind === 'inbox-ticket') {
    // presigned が作れない置き場では、関数が引換券を確かめて置いてくれる。
    // Apps Script は状態コードを選べないので、本文の error も失敗として扱う。
    const response = await fetch(`${item.path}?path=${encodeURIComponent('/inbox')}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        group_id: item.groupId,
        key: item.key,
        body: toBase64(item.body),
        ticket: item.ticket,
      }),
    })
    if (!response.ok) {
      throw new Error(`inbox upload failed with status ${String(response.status)}`)
    }
    const body = (await response.json()) as { error?: string }
    if (typeof body.error === 'string') {
      throw new Error(`inbox upload was refused: ${body.error}`)
    }
    return
  }
  if (item.kind === 'inbox') {
    const response = await fetch(item.path, { method: 'PUT', body: item.body })
    if (!response.ok) {
      throw new Error(`inbox upload failed with status ${response.status}`)
    }
    return
  }
  await storage.put(item.path, item.body)
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
      await send(options.storage, item)
      await options.db.outbox.delete(item.id)
      sent += 1
    } catch {
      await options.db.outbox.put({ ...item, attempts: item.attempts + 1 })
      failed += 1
    }
  }
  return { sent, failed }
}
