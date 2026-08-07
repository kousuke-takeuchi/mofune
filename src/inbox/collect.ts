import type { Bytes } from '../crypto/bytes'
import type { Session } from '../group/session'
import type { StorageProvider } from '../storage/provider'
import { openAsRecipient } from './uplink'

export interface CollectedItem {
  /** ストレージ上のキー。処理後に discardInboxItem へ渡す。 */
  key: string
  body: Bytes
}

export interface CollectResult {
  items: CollectedItem[]
  /** 自分の鍵では開けなかった投函物の数。異常ではない(設計書 §4.6)。 */
  unreadable: number
}

/** 担当者が置いた配布物であって、投函物ではない。 */
function isGrant(key: string): boolean {
  return key.endsWith('/grant.enc')
}

export async function collectInbox(options: {
  storage: StorageProvider
  session: Session
}): Promise<CollectResult> {
  const entries = await options.storage.list(`${options.session.groupId}/inbox/`)
  const items: CollectedItem[] = []
  let unreadable = 0

  for (const entry of entries) {
    if (isGrant(entry.path)) continue
    try {
      const sealed = await options.storage.get(entry.path)
      const body = await openAsRecipient(
        options.session.userId,
        options.session.ecdhPrivate,
        sealed,
      )
      items.push({ key: entry.path, body })
    } catch {
      // 自分が担当者になる前の投函物は開けない。受容済みの制約。
      unreadable += 1
    }
  }

  return { items, unreadable }
}

export async function discardInboxItem(options: {
  storage: StorageProvider
  key: string
}): Promise<void> {
  await options.storage.delete(options.key)
}
