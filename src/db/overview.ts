import { isClosed } from '../content/forms'
import { openGroupDatabase } from './group-db'

/**
 * グループごとの「いま待っていること」(原稿 11 の横断ダッシュボード)。
 *
 * 端末に控えてある復号済みの中身だけを数えるので、**解錠していない
 * グループでも出せる**。鍵は要らず、既読も上りへは出さない (要件書 §4.10)。
 */
export interface GroupOverview {
  groupId: string
  unread: number
  /** 締切前の問いのうち、まだ答えていないもの。 */
  needsAnswer: number
  /** 担当者が「送った」と言っていないメール。 */
  unsentBatches: number
  lastSyncedAt: string | null
  needsAttention: boolean
}

const EMPTY = { unread: 0, needsAnswer: 0, unsentBatches: 0, lastSyncedAt: null }

export async function groupOverview(groupId: string): Promise<GroupOverview> {
  try {
    const db = openGroupDatabase(groupId)
    const [messages, deliveries, readState, syncState] = await Promise.all([
      db.messages.toArray(),
      db.deliveries.toArray(),
      db.syncState.get('lastReadAt'),
      db.syncState.get('lastSyncedAt'),
    ])

    const lastReadAt = readState?.value ?? null
    const unread = messages.filter(
      (message) => lastReadAt === null || message.at > lastReadAt,
    ).length
    const needsAnswer = messages.filter(
      (message) => message.form !== undefined && !isClosed(message.form),
    ).length
    const unsentBatches = deliveries.filter((record) => record.sentAt === null).length

    return {
      groupId,
      unread,
      needsAnswer,
      unsentBatches,
      lastSyncedAt: syncState?.value ?? null,
      needsAttention: unread > 0 || needsAnswer > 0 || unsentBatches > 0,
    }
  } catch {
    // 一度も開いていないグループには DB が無い。何も待っていない
    return { groupId, ...EMPTY, needsAttention: false }
  }
}

export async function overviewFor(groupIds: string[]): Promise<Record<string, GroupOverview>> {
  const all = await Promise.all(groupIds.map((groupId) => groupOverview(groupId)))
  return Object.fromEntries(all.map((overview) => [overview.groupId, overview]))
}
