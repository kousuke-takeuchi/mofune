import type { Bytes } from '../crypto/bytes'
import { fromUtf8, toHex, utf8 } from '../crypto/bytes'
import { randomBytes } from '../crypto/symmetric'
import type { GroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import type { InboxGrant } from '../inbox/grants'
import { submitToInbox } from '../inbox/submit'

export class AbsenceError extends Error {}

export type AbsenceKind = 'absent' | 'late' | 'early'

/** design 05 の「欠席 / 遅れます / 早く帰ります」。 */
export const ABSENCE_KINDS: readonly AbsenceKind[] = ['absent', 'late', 'early']

/**
 * よく使う理由の初期値。Phase 2d でグループ設定 (settings/templates.enc) から
 * 読み込めるようにするまでの暫定。
 */
export const DEFAULT_REASONS: readonly string[] = ['体調不良', '通院', '家庭の都合']

export interface AbsenceReport {
  id: string
  kind: AbsenceKind
  /** YYYY-MM-DD */
  date: string
  reason: string
  note: string
  author: string
  at: string
}

export function newAbsenceId(): string {
  return `ab_${toHex(randomBytes(16))}`
}

export function buildAbsenceReport(options: {
  session: Session
  kind: AbsenceKind
  date: string
  reason: string
  note: string
  now?: Date
}): AbsenceReport {
  if (!ABSENCE_KINDS.includes(options.kind)) {
    throw new AbsenceError(`unknown absence kind "${String(options.kind)}"`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new AbsenceError(`date must be YYYY-MM-DD, got "${options.date}"`)
  }
  const now = options.now ?? new Date()
  return {
    id: newAbsenceId(),
    kind: options.kind,
    date: options.date,
    reason: options.reason,
    note: options.note,
    author: options.session.userId,
    at: now.toISOString(),
  }
}

export function parseAbsenceReport(bytes: Bytes): AbsenceReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new AbsenceError('absence report is not valid JSON')
  }
  const report = parsed as AbsenceReport
  if (
    report === null ||
    typeof report !== 'object' ||
    typeof report.id !== 'string' ||
    typeof report.date !== 'string' ||
    typeof report.author !== 'string' ||
    !ABSENCE_KINDS.includes(report.kind)
  ) {
    throw new AbsenceError('absence report is missing required fields')
  }
  return report
}

/** 宛先は担当者・管理者の全員。封緘は submitToInbox が受け持つ。 */
export async function sendAbsenceReport(options: {
  session: Session
  db: GroupDatabase
  grant: InboxGrant
  report: AbsenceReport
  now?: Date
}): Promise<{ key: string }> {
  return submitToInbox({
    session: options.session,
    db: options.db,
    grant: options.grant,
    plaintext: utf8(JSON.stringify(options.report)),
    now: options.now,
  })
}
