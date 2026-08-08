import { openGroupDatabase } from './group-db'

/**
 * 未読の件数。端末のローカル計算のみで、誰が読んだかはどこへも送らない
 * (要件書 §4.10)。鍵は要らない。本文はすでに復号して端末に控えてある。
 */
export async function countUnread(groupId: string): Promise<number> {
  try {
    const db = openGroupDatabase(groupId)
    const [messages, state] = await Promise.all([
      db.messages.toArray(),
      db.syncState.get('lastReadAt'),
    ])
    const lastReadAt = state?.value ?? null
    return messages.filter((message) => lastReadAt === null || message.at > lastReadAt).length
  } catch {
    // まだ一度も開いていないグループは DB も無い。0 でよい。
    return 0
  }
}

/** グループごとの未読件数。切替画面で使う。 */
export async function countUnreadFor(groupIds: string[]): Promise<Record<string, number>> {
  const counts = await Promise.all(groupIds.map((groupId) => countUnread(groupId)))
  return Object.fromEntries(groupIds.map((groupId, index) => [groupId, counts[index] ?? 0]))
}
