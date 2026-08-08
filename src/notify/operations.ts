import type { RosterContents } from '../crypto/roster'
import type { GroupDatabase } from '../db/group-db'
import type { ContactBook } from '../group/contacts'
import { pendingBatches } from './delivery-log'

/**
 * 運営の側でいま気にすべきこと (原稿 08 / 11)。
 *
 * すべて端末の中の控えから数える。送ったかどうかは機械的に確かめられないので
 * (要件書 §6-2)、担当者の申告が残っていないバッチを「未送信」として出す。
 */
export interface OperationStatus {
  unsentBatches: number
  /** 未送信バッチが抱えている宛先の延べ人数。 */
  unsentRecipients: number
  /** まだ送り終えていないお知らせ。画面から辿れるようにする。 */
  unsentMessageIds: string[]
  /** メールアドレスが分からない人。この人たちには通知が届かない。 */
  withoutEmail: number
  lastSyncedAt: string | null
  needsAttention: boolean
}

export async function operationStatus(options: {
  db: GroupDatabase
  roster: RosterContents
  contacts: ContactBook
}): Promise<OperationStatus> {
  const pending = await pendingBatches(options.db)
  const withoutEmail = options.roster.members.filter(
    (member) => (options.contacts[member.userId]?.email ?? '').trim() === '',
  ).length

  const unsentRecipients = pending.reduce((total, record) => total + record.recipients, 0)
  const unsentMessageIds = [...new Set(pending.map((record) => record.messageId))]

  return {
    unsentBatches: pending.length,
    unsentRecipients,
    unsentMessageIds,
    withoutEmail,
    lastSyncedAt: (await options.db.syncState.get('lastSyncedAt'))?.value ?? null,
    needsAttention: pending.length > 0 || withoutEmail > 0,
  }
}
