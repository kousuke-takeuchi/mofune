import type { Bytes } from '../crypto/bytes'
import type { GroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import { enqueue } from '../sync/outbox'
import type { InboxGrant, InboxSlot } from './grants'
import { sealForRecipients, staffRecipients } from './uplink'

export class SubmitError extends Error {}

/** 使用済みスロットを記録する syncState のキー。 */
export const USED_SLOTS_KEY = 'usedInboxSlots'

export async function usedSlots(db: GroupDatabase): Promise<string[]> {
  const row = await db.syncState.get(USED_SLOTS_KEY)
  if (!row?.value) return []
  try {
    return JSON.parse(row.value) as string[]
  } catch {
    return []
  }
}

/**
 * まだ使っていない枠を1つ返す。
 * 同じ presigned URL に二度 PUT すると前の投函を上書きしてしまうので、
 * 使用済みの記録は必ず参照する。
 */
export function nextSlot(grant: InboxGrant, used: string[], now: Date = new Date()): InboxSlot {
  if (Date.parse(grant.expiresAt) <= now.getTime()) {
    throw new SubmitError('the inbox grant has expired; wait for staff to open the app')
  }
  const free = grant.slots.find((slot) => !used.includes(slot.key))
  if (!free) {
    throw new SubmitError('all inbox slots have been used; wait for staff to open the app')
  }
  return free
}

/**
 * 担当者・管理者の公開鍵へ封緘して投函する。
 * 送信自体は outbox 経由なので、オフラインで書いたものも失われない(要件書 §4.9)。
 */
export async function submitToInbox(options: {
  session: Session
  db: GroupDatabase
  grant: InboxGrant
  plaintext: Bytes
  now?: Date
}): Promise<{ key: string }> {
  const recipients = staffRecipients(options.session.roster)
  const sealed = await sealForRecipients(recipients, options.plaintext)

  const used = await usedSlots(options.db)
  const slot = nextSlot(options.grant, used, options.now)

  await enqueue(options.db, {
    id: slot.key,
    kind: 'inbox',
    // presigned URL をそのまま送信先にする
    path: slot.url,
    body: sealed,
  })
  await options.db.syncState.put({
    key: USED_SLOTS_KEY,
    value: JSON.stringify([...used, slot.key]),
  })

  return { key: slot.key }
}
