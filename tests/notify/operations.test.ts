import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { operationStatus } from '../../src/notify/operations'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import type { RosterContents } from '../../src/crypto/roster'
import type { ContactBook } from '../../src/group/contacts'

const roster: RosterContents = {
  groupId: 'midori',
  generation: 1,
  subgroups: [],
  members: [
    {
      userId: 'u_tanaka',
      displayName: '田中 みか',
      role: 'staff',
      scopes: ['all', 'staff'],
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
    {
      userId: 'u_sato',
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: ['all'],
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
    {
      userId: 'u_mori',
      displayName: '森 ゆい',
      role: 'member',
      scopes: ['all'],
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
  ],
}

const contacts: ContactBook = { u_sato: { email: 'sakura@example.com' } }

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('operationStatus', () => {
  it('counts the mail batches nobody has said they sent', async () => {
    const db = openGroupDatabase('midori')
    await db.deliveries.bulkPut([
      { id: 'm_1#1', messageId: 'm_1', batchIndex: 1, total: 2, recipients: 20, sentAt: null },
      { id: 'm_1#2', messageId: 'm_1', batchIndex: 2, total: 2, recipients: 4, sentAt: null },
      {
        id: 'm_0#1',
        messageId: 'm_0',
        batchIndex: 1,
        total: 1,
        recipients: 9,
        sentAt: '2026-08-07T00:00:00.000Z',
      },
    ])

    const status = await operationStatus({ db, roster, contacts })
    expect(status.unsentBatches).toBe(2)
    expect(status.unsentRecipients).toBe(24)
    expect(status.unsentMessageIds).toEqual(['m_1'])
  })

  it('counts the people who cannot be reached by mail', async () => {
    const db = openGroupDatabase('midori')
    const status = await operationStatus({ db, roster, contacts })
    // 田中(担当者・自分)も含めて、アドレスが無いのは2人
    expect(status.withoutEmail).toBe(2)
  })

  it('says when the group last synced', async () => {
    const db = openGroupDatabase('midori')
    await db.syncState.put({ key: 'lastSyncedAt', value: '2026-08-08T09:00:00.000Z' })
    const status = await operationStatus({ db, roster, contacts })
    expect(status.lastSyncedAt).toBe('2026-08-08T09:00:00.000Z')
  })

  it('is quiet when there is nothing to do', async () => {
    const db = openGroupDatabase('midori')
    const status = await operationStatus({
      db,
      roster,
      contacts: { u_tanaka: { email: 'a@b.c' }, u_sato: { email: 'd@e.f' }, u_mori: { email: 'g@h.i' } },
    })
    expect(status.unsentBatches).toBe(0)
    expect(status.withoutEmail).toBe(0)
    expect(status.needsAttention).toBe(false)
  })

  it('asks for attention while anything is outstanding', async () => {
    const db = openGroupDatabase('midori')
    const status = await operationStatus({ db, roster, contacts })
    expect(status.needsAttention).toBe(true)
  })
})
