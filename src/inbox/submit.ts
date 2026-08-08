import type { Bytes } from '../crypto/bytes'
import { toHex } from '../crypto/bytes'
import { randomBytes } from '../crypto/symmetric'
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

/** 自分の受信箱に置くキー。誰がいつ何件投函したかを推測しにくいよう乱数にする。 */
export function inboxKeyFor(session: Session): string {
  return `${session.groupId}/inbox/${session.userId}/${toHex(randomBytes(16))}.enc`
}

/**
 * すでに封緘済みのものを、配られた枠で投函する。
 * 宛先を呼び出し側が決めたいとき (フォームの回答は作成者だけに宛てる) に使う。
 */
export async function submitSealedToInbox(options: {
  session: Session
  db: GroupDatabase
  grant: InboxGrant
  sealed: Bytes
  now?: Date
}): Promise<{ key: string }> {
  const used = await usedSlots(options.db)
  const slot = nextSlot(options.grant, used, options.now)

  await enqueue(options.db, {
    id: slot.key,
    kind: 'inbox',
    path: slot.url,
    body: options.sealed,
  })
  await options.db.syncState.put({
    key: USED_SLOTS_KEY,
    value: JSON.stringify([...used, slot.key]),
  })
  return { key: slot.key }
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

/**
 * 投函枠を使わずに直接書き込む。
 *
 * 枠 (presigned URL) は参加者にしか配られない。担当者・管理者は書き込み資格情報を
 * 持っているので、枠を待つ理由がない。要件書 §3 は不在連絡を全ロールに認めており、
 * 枠を必須にすると担当者だけ連絡できないという妙なことになる。
 *
 * 封緘先は枠経由と同じ「担当者・管理者の公開鍵」なので、保存されるものは変わらない。
 */
export async function submitDirectly(options: {
  session: Session
  db: GroupDatabase
  plaintext: Bytes
}): Promise<{ key: string }> {
  const recipients = staffRecipients(options.session.roster)
  const sealed = await sealForRecipients(recipients, options.plaintext)
  const key = inboxKeyFor(options.session)

  await enqueue(options.db, { id: key, kind: 'object', path: key, body: sealed })
  return { key }
}
