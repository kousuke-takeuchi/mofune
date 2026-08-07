import type { Bytes } from '../crypto/bytes'
import { fromUtf8, utf8 } from '../crypto/bytes'
import type { GroupDatabase } from '../db/group-db'
import type { InboxGrant } from '../inbox/grants'
import { submitToInbox } from '../inbox/submit'
import type { Session } from './session'

export class EmailRegistrationError extends Error {}

export const EMAIL_REGISTRATION_VERSION = 1
export const EMAIL_CONFIRMED_KEY = 'emailConfirmed' as const

export interface EmailRegistration {
  v: number
  userId: string
  email: string
  at: string
}

/**
 * 形式のごく粗いチェックだけを行う。厳密な正規表現は、正しいアドレスを
 * 弾いてしまう事故のほうが多い。到達性はテスト通知を送って本人が確認する
 * 運用で担保する(要件書 §4.6)。
 */
export function isPlausibleEmail(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false
  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return false
  const domain = trimmed.slice(at + 1)
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')
}

export function buildEmailRegistration(options: {
  session: Session
  email: string
  now?: Date
}): EmailRegistration {
  const email = options.email.trim()
  if (!isPlausibleEmail(email)) {
    throw new EmailRegistrationError(`"${options.email}" does not look like an email address`)
  }
  return {
    v: EMAIL_REGISTRATION_VERSION,
    userId: options.session.userId,
    email,
    at: (options.now ?? new Date()).toISOString(),
  }
}

export function parseEmailRegistration(bytes: Bytes): EmailRegistration {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new EmailRegistrationError('registration is not valid JSON')
  }
  const registration = parsed as EmailRegistration
  if (
    registration === null ||
    typeof registration !== 'object' ||
    typeof registration.userId !== 'string' ||
    typeof registration.email !== 'string' ||
    registration.v !== EMAIL_REGISTRATION_VERSION
  ) {
    throw new EmailRegistrationError('registration is missing required fields')
  }
  return registration
}

export async function sendEmailRegistration(options: {
  session: Session
  db: GroupDatabase
  grant: InboxGrant
  registration: EmailRegistration
  now?: Date
}): Promise<{ key: string }> {
  return submitToInbox({
    session: options.session,
    db: options.db,
    grant: options.grant,
    plaintext: utf8(JSON.stringify(options.registration)),
    now: options.now,
  })
}

/**
 * 到達確認は本人の自己申告(design 02)。機械的な検証はできないので、
 * 端末ローカルのロック解除フラグとして扱う。
 */
export async function markEmailConfirmed(db: GroupDatabase): Promise<void> {
  await db.syncState.put({ key: EMAIL_CONFIRMED_KEY, value: new Date().toISOString() })
}

export async function isEmailConfirmed(db: GroupDatabase): Promise<boolean> {
  return Boolean((await db.syncState.get(EMAIL_CONFIRMED_KEY))?.value)
}
