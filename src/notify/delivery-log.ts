import type { DeliveryRecord, GroupDatabase } from '../db/group-db'
import type { MailBatch } from './mailto'

function recordId(messageId: string, batchIndex: number): string {
  return `${messageId}#${batchIndex}`
}

export async function recordBatches(options: {
  db: GroupDatabase
  messageId: string
  batches: MailBatch[]
}): Promise<void> {
  for (const batch of options.batches) {
    const id = recordId(options.messageId, batch.index)
    // 既に記録済みなら送信状況を上書きしない
    if (await options.db.deliveries.get(id)) continue
    const record: DeliveryRecord = {
      id,
      messageId: options.messageId,
      batchIndex: batch.index,
      total: batch.total,
      recipients: batch.recipients.length,
      sentAt: null,
    }
    await options.db.deliveries.put(record)
  }
}

/**
 * 送信したかどうかは機械的に検証できない(要件書 §6-2)。
 * mailto: はメーラーを開くだけなので、担当者の自己申告を記録する。
 */
export async function markBatchSent(options: {
  db: GroupDatabase
  messageId: string
  batchIndex: number
  now?: Date
}): Promise<void> {
  const id = recordId(options.messageId, options.batchIndex)
  const record = await options.db.deliveries.get(id)
  if (!record) return
  await options.db.deliveries.put({
    ...record,
    sentAt: (options.now ?? new Date()).toISOString(),
  })
}

export async function pendingBatches(
  db: GroupDatabase,
  messageId?: string,
): Promise<DeliveryRecord[]> {
  const all = await db.deliveries.toArray()
  return all
    .filter((record) => record.sentAt === null)
    .filter((record) => messageId === undefined || record.messageId === messageId)
    .sort((a, b) => a.batchIndex - b.batchIndex)
}
