import type { Bytes } from '../crypto/bytes'
import type { SealTarget } from '../crypto/envelope'
import type { GroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import { filePath, messagePath } from '../storage/paths'
import type { GroupEvent } from '../sync/events'
import { eventPathFor, newEventId, sealEvent } from '../sync/events'
import { enqueue } from '../sync/outbox'
import type { AttachmentRef } from './attachments'
import { sealAttachment } from './attachments'
import type { FormDefinition } from './forms'
import type { MessageContent } from './messages'
import { newMessageId, sealMessage } from './messages'

export class PostError extends Error {}

export interface DraftAttachment {
  name: string
  mediaType: string
  bytes: Bytes
}

export interface Draft {
  /** 見出し。空なら付けない。 */
  title: string
  body: string
  /** 素のスコープ id。世代は resolveTargets が付ける。 */
  scopes: string[]
  attachments: DraftAttachment[]
  form?: FormDefinition
}

export interface PostResult {
  messageId: string
  eventId: string
  attachments: AttachmentRef[]
}

/**
 * スコープ名を、セッションが実際に保持している鍵の keyId へ解決する。
 * 世代を投稿側で決め打ちせず、手元の鍵の世代をそのまま使う。
 * 鍵を持たないスコープが混ざっていたら投稿を中止する。黙って落とすと
 * 「送ったのに届いていない」ことに投稿者が気づけない。
 */
export function resolveTargets(session: Session, scopes: string[]): SealTarget[] {
  const unique = [...new Set(scopes)]
  if (unique.length === 0) {
    throw new PostError('a post needs at least one target scope')
  }
  return unique.map((scope) => {
    const entry = [...session.groupKeys.entries()].find(
      ([id]) => id.slice(0, id.lastIndexOf(':v')) === scope,
    )
    if (!entry) {
      throw new PostError(`no key held for scope "${scope}"`)
    }
    return { keyId: entry[0], key: entry[1] }
  })
}

/**
 * 添付・本体・イベントを同じ宛先集合で封緘し、outbox へ積む。
 * 添付 → 本体 → イベントの順に積むことで、受信側がイベントを見た時点で
 * 参照先が揃っている(outbox は queuedAt 順に送る)。
 */
export async function createPost(options: {
  session: Session
  db: GroupDatabase
  draft: Draft
  now?: Date
}): Promise<PostResult> {
  const { session, db, draft } = options
  if (session.role === 'member') {
    throw new PostError('members cannot post')
  }
  if (draft.body.trim().length === 0 && draft.attachments.length === 0) {
    throw new PostError('a post needs a body or at least one attachment')
  }

  const targets = resolveTargets(session, draft.scopes)
  const now = options.now ?? new Date()
  const at = now.toISOString()

  const attachments: AttachmentRef[] = []
  for (const attachment of draft.attachments) {
    const { ref, sealed } = await sealAttachment(attachment, targets)
    attachments.push(ref)
    await enqueue(db, {
      id: ref.fileId,
      kind: 'object',
      path: filePath(session.groupId, ref.fileId),
      body: sealed,
    })
    // 自分が選んだ実物を控える。取り直すまでサムネイルが出ないのを避ける
    await db.files.put({
      id: ref.fileId,
      mediaType: attachment.mediaType,
      size: attachment.bytes.length,
      blob: attachment.bytes,
      cachedAt: at,
    })
  }

  const message: MessageContent = {
    id: newMessageId(),
    scopes: [...new Set(draft.scopes)],
    author: session.userId,
    at,
    ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
    body: draft.body,
    attachments,
    ...(draft.form ? { form: draft.form } : {}),
  }
  await enqueue(db, {
    id: message.id,
    kind: 'object',
    path: messagePath(session.groupId, message.id),
    body: await sealMessage(message, targets),
  })

  // 送った本人の端末にも控えを置く。置かないと、同期で戻ってくるまで
  // 自分の投稿がタイムラインにも集計にも出てこない (実機で発覚)。
  await db.messages.put({
    id: message.id,
    scopes: message.scopes,
    author: message.author,
    at: message.at,
    ...(message.title ? { title: message.title } : {}),
    body: message.body,
    attachments: attachments.map((ref) => ref.fileId),
    ...(message.form ? { form: message.form } : {}),
  })

  const event: GroupEvent = {
    id: newEventId(now),
    type: 'MESSAGE_CREATED',
    author: session.userId,
    at,
    payload: { messageId: message.id },
  }
  await enqueue(db, {
    id: event.id,
    kind: 'event',
    path: eventPathFor(session.groupId, event.id),
    body: await sealEvent(event, targets),
  })

  return { messageId: message.id, eventId: event.id, attachments }
}
