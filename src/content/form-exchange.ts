import { utf8 } from '../crypto/bytes'
import type { GroupDatabase, StoredFormResponse } from '../db/group-db'
import type { Session } from '../group/session'
import { collectInbox, discardInboxItem } from '../inbox/collect'
import { readGrant } from '../inbox/grants'
import { inboxKeyFor, submitSealedToInbox } from '../inbox/submit'
import { sealForRecipients } from '../inbox/uplink'
import type { StorageProvider } from '../storage/provider'
import { enqueue } from '../sync/outbox'
import type { FormDefinition } from './forms'
import { buildResponse, isFormResponse, parseFormResponse } from './forms'

/**
 * 回答を作成者だけに宛てて投函する。
 *
 * 宛先は staff スコープではなく作成者ひとり。担当者が複数いても、作成者以外は
 * 開けない (デザイン 04)。送り方は不在連絡と同じで、参加者は配られた投函枠、
 * 書き込み資格情報を持つ人は直接。
 */
export async function sendFormResponse(options: {
  session: Session
  db: GroupDatabase
  storage: StorageProvider
  form: FormDefinition
  messageId: string
  choice: string
  note: string
  now?: Date
}): Promise<void> {
  const response = buildResponse({
    session: options.session,
    formId: options.form.id,
    messageId: options.messageId,
    choice: options.choice,
    note: options.note,
    ...(options.now ? { now: options.now } : {}),
  })
  const sealed = await sealForRecipients(
    [{ userId: options.form.recipient.userId, ecdhPublic: options.form.recipient.ecdhPublic }],
    utf8(JSON.stringify(response)),
  )

  if (options.storage.capabilities.write) {
    // 担当者・管理者は枠を待たずに自分で置ける
    const key = inboxKeyFor(options.session)
    await enqueue(options.db, { id: key, kind: 'object', path: key, body: sealed })
    return
  }

  const grant = await readGrant({
    storage: options.storage,
    groupId: options.session.groupId,
    userId: options.session.userId,
    ecdhPrivate: options.session.ecdhPrivate,
  })
  await submitSealedToInbox({
    session: options.session,
    db: options.db,
    grant,
    sealed,
  })
}

/**
 * 自分宛の回答を回収して端末へ残す。
 *
 * 開けなかった投函物は `collectInbox` が消さずに数えるので、ほかの担当者が
 * 受信箱を処理しても回答は残る。
 */
export async function collectFormResponses(options: {
  session: Session
  storage: StorageProvider
  db: GroupDatabase
}): Promise<{ collected: number }> {
  const { items } = await collectInbox({ storage: options.storage, session: options.session })
  let collected = 0

  for (const item of items) {
    if (!isFormResponse(item.body)) continue
    const response = parseFormResponse(item.body)
    const stored: StoredFormResponse = {
      // 同じ人の答え直しは上書きする。押し直しは訂正であって2票ではない。
      id: `${response.formId}:${response.userId}`,
      formId: response.formId,
      messageId: response.messageId,
      userId: response.userId,
      displayName: response.displayName,
      choice: response.choice,
      note: response.note,
      at: response.at,
    }
    const previous = await options.db.formResponses.get(stored.id)
    if (!previous || previous.at <= stored.at) {
      await options.db.formResponses.put(stored)
    }
    // 端末へ残してから消す。逆にすると書き込み失敗で回答が失われる。
    await discardInboxItem({ storage: options.storage, key: item.key })
    collected += 1
  }

  return { collected }
}
