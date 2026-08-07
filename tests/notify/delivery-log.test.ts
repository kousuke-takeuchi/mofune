import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { markBatchSent, pendingBatches, recordBatches } from '../../src/notify/delivery-log'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import type { MailBatch } from '../../src/notify/mailto'

const batches: MailBatch[] = [
  { index: 1, total: 2, url: 'mailto:a', recipients: [] },
  { index: 2, total: 2, url: 'mailto:b', recipients: [] },
]

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('delivery log', () => {
  it('records every batch as unsent', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    const pending = await pendingBatches(db, 'm_1')
    expect(pending).toHaveLength(2)
    expect(pending.every((record) => record.sentAt === null)).toBe(true)
  })

  it('marks one batch as sent without touching the other', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    await markBatchSent({ db, messageId: 'm_1', batchIndex: 1 })
    const pending = await pendingBatches(db, 'm_1')
    expect(pending.map((record) => record.batchIndex)).toEqual([2])
  })

  it('records when the batch was said to be sent', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    await markBatchSent({ db, messageId: 'm_1', batchIndex: 1, now: new Date('2026-08-08T10:00:00.000Z') })
    const all = await db.deliveries.toArray()
    const sent = all.find((record) => record.batchIndex === 1)
    expect(sent?.sentAt).toBe('2026-08-08T10:00:00.000Z')
  })

  it('reports nothing pending once every batch is sent', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    await markBatchSent({ db, messageId: 'm_1', batchIndex: 1 })
    await markBatchSent({ db, messageId: 'm_1', batchIndex: 2 })
    expect(await pendingBatches(db, 'm_1')).toHaveLength(0)
  })

  it('keeps different messages apart', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    await recordBatches({ db, messageId: 'm_2', batches })
    await markBatchSent({ db, messageId: 'm_1', batchIndex: 1 })
    expect(await pendingBatches(db, 'm_1')).toHaveLength(1)
    expect(await pendingBatches(db, 'm_2')).toHaveLength(2)
  })

  it('lists everything still unsent across messages', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    await recordBatches({ db, messageId: 'm_2', batches })
    expect(await pendingBatches(db)).toHaveLength(4)
  })

  it('does not duplicate when the same batches are recorded twice', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    await recordBatches({ db, messageId: 'm_1', batches })
    expect(await db.deliveries.count()).toBe(2)
  })

  it('ignores marking a batch that was never recorded', async () => {
    const db = openGroupDatabase('midori')
    await markBatchSent({ db, messageId: 'm_zzz', batchIndex: 1 })
    expect(await db.deliveries.count()).toBe(0)
  })
})
