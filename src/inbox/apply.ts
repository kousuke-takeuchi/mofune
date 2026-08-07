import type { Bytes } from '../crypto/bytes'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import { parseAbsenceReport } from '../content/absence'
import { parseEmailRegistration } from '../group/email-registration'
import type { Session } from '../group/session'
import type { StorageProvider } from '../storage/provider'
import type { GroupEvent } from '../sync/events'
import { eventPathFor, newEventId, sealEvent } from '../sync/events'
import { collectInbox, discardInboxItem } from './collect'

export class ApplyError extends Error {}

export type SubmissionKind = 'absence' | 'email' | 'unknown'

export interface ApplyResult {
  absences: number
  emails: number
  /** 判別できなかった投函物。削除しない。 */
  unknown: number
  /** 自分の鍵では開けなかった投函物。削除しない。 */
  unreadable: number
  /** 名簿へ反映すべき連絡先。適用は管理者の作業(Task 2)。 */
  pendingContactUpdates: Array<{ userId: string; email: string }>
}

export function classifySubmission(body: Bytes): SubmissionKind {
  try {
    parseAbsenceReport(body)
    return 'absence'
  } catch {
    // 次を試す
  }
  try {
    parseEmailRegistration(body)
    return 'email'
  } catch {
    return 'unknown'
  }
}

/**
 * inbox を回収して種類ごとに処理する。
 *
 * 不在連絡は staff スコープ宛のイベントへ転記する。担当者ひとりの端末に
 * 留めると、回収した本人以外は見られないため。
 *
 * メールアドレスは名簿へ書かずに返すだけにする。名簿の再署名は管理者しか
 * できないので、担当者の回収で書き換えようとしても失敗する。
 */
export async function applyInbox(options: {
  storage: StorageProvider
  session: Session
  now?: Date
}): Promise<ApplyResult> {
  if (options.session.role === 'member') {
    throw new ApplyError('members cannot process the inbox')
  }

  const staffKeyId = keyId(STAFF_SCOPE, 1)
  const staffKey = options.session.groupKeys.get(staffKeyId)
  if (!staffKey) {
    throw new ApplyError('the staff scope key is required to process the inbox')
  }

  const collected = await collectInbox({ storage: options.storage, session: options.session })
  const result: ApplyResult = {
    absences: 0,
    emails: 0,
    unknown: 0,
    unreadable: collected.unreadable,
    pendingContactUpdates: [],
  }
  const now = options.now ?? new Date()

  for (const item of collected.items) {
    const kind = classifySubmission(item.body)

    if (kind === 'absence') {
      const report = parseAbsenceReport(item.body)
      const event: GroupEvent = {
        id: newEventId(now),
        type: 'ABSENCE_REPORTED',
        author: options.session.userId,
        at: now.toISOString(),
        payload: { absence: report },
      }
      // 転記に成功してから消す。逆にすると書き込み失敗で投函物が失われる。
      await options.storage.put(
        eventPathFor(options.session.groupId, event.id),
        await sealEvent(event, [{ keyId: staffKeyId, key: staffKey }]),
      )
      await discardInboxItem({ storage: options.storage, key: item.key })
      result.absences += 1
      continue
    }

    if (kind === 'email') {
      const registration = parseEmailRegistration(item.body)
      result.pendingContactUpdates.push({
        userId: registration.userId,
        email: registration.email,
      })
      await discardInboxItem({ storage: options.storage, key: item.key })
      result.emails += 1
      continue
    }

    // 判別できないものは消さない。消すと復旧できない。
    result.unknown += 1
  }

  return result
}
