import { openAttachment } from '../content/attachments'
import { openMessage } from '../content/messages'
import type { CachedAbsence, CachedFile, CachedMessage, GroupDatabase } from '../db/group-db'
import type { StorageProvider } from '../storage/provider'
import { filePath, messagePath } from '../storage/paths'
import type { GroupEvent } from './events'

export interface ProjectionResult {
  messages: number
  files: number
  absences: number
  /** 参照先がまだ届いていない等で解決できなかった数。異常ではない。 */
  missing: number
}

/**
 * イベントを messages / files テーブルへ投影する。
 *
 * 参照先が取得できないのは正常系(投稿者の outbox がまだ送り終えていない、
 * 添付だけ失敗している等)。例外にせず missing として数え、イベント自体は
 * events テーブルに残るので次回以降に再投影できる。
 */
export async function projectEvent(options: {
  db: GroupDatabase
  storage: StorageProvider
  groupId: string
  keys: ReadonlyMap<string, CryptoKey>
  event: GroupEvent
}): Promise<ProjectionResult> {
  const result: ProjectionResult = { messages: 0, files: 0, absences: 0, missing: 0 }

  if (options.event.type === 'ABSENCE_REPORTED') {
    const absence = options.event.payload['absence']
    if (absence === null || typeof absence !== 'object') {
      result.missing += 1
      return result
    }
    const cached = absence as CachedAbsence
    if (typeof cached.id !== 'string') {
      result.missing += 1
      return result
    }
    await options.db.absences.put(cached)
    result.absences += 1
    return result
  }

  if (options.event.type !== 'MESSAGE_CREATED') {
    return result
  }

  const messageId = options.event.payload['messageId']
  if (typeof messageId !== 'string') {
    result.missing += 1
    return result
  }

  let message
  try {
    message = await openMessage(
      options.keys,
      await options.storage.get(messagePath(options.groupId, messageId)),
    )
  } catch {
    result.missing += 1
    return result
  }

  const cached: CachedMessage = {
    id: message.id,
    scopes: message.scopes,
    author: message.author,
    at: message.at,
    body: message.body,
    attachments: message.attachments.map((attachment) => attachment.fileId),
  }
  await options.db.messages.put(cached)
  result.messages += 1

  for (const ref of message.attachments) {
    if (await options.db.files.get(ref.fileId)) continue
    try {
      const opened = await openAttachment(
        options.keys,
        await options.storage.get(filePath(options.groupId, ref.fileId)),
      )
      const file: CachedFile = {
        id: ref.fileId,
        mediaType: opened.mediaType,
        size: opened.bytes.length,
        blob: opened.bytes,
        cachedAt: new Date().toISOString(),
      }
      await options.db.files.put(file)
      result.files += 1
    } catch {
      result.missing += 1
    }
  }

  return result
}
