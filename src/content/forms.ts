import type { Bytes } from '../crypto/bytes'
import { fromUtf8, toHex } from '../crypto/bytes'
import { randomBytes } from '../crypto/symmetric'
import type { Session } from '../group/session'

export class FormError extends Error {}

/** 出欠を訊くときの既定の選択肢。 */
export const DEFAULT_ATTENDANCE_CHOICES = ['参加します', '欠席します']

export interface FormDefinition {
  id: string
  question: string
  choices: string[]
  allowNote: boolean
  dueAt: string | null
  /**
   * 回答を開ける人。作成者だけ。
   * staff スコープにしないのは、担当者が複数いても互いの集計を読めないようにするため
   * (デザイン 04「回答は作成した担当者だけが読めます」)。
   */
  recipient: { userId: string; ecdhPublic: string }
}

export interface FormResponse {
  kind: 'form-response'
  formId: string
  messageId: string
  userId: string
  displayName: string
  choice: string
  note: string
  at: string
}

export function newFormId(): string {
  return `f_${toHex(randomBytes(8))}`
}

export function buildForm(options: {
  session: Session
  question: string
  choices: string[]
  allowNote: boolean
  dueAt: string | null
}): FormDefinition {
  const question = options.question.trim()
  if (question.length === 0) {
    throw new FormError('質問を入れてください')
  }
  const choices = options.choices.map((choice) => choice.trim()).filter(Boolean)
  if (choices.length < 2) {
    // 選べないものは問いではない
    throw new FormError('選択肢は2つ以上にしてください')
  }

  const me = options.session.roster.members.find(
    (member) => member.userId === options.session.userId,
  )
  if (!me) {
    throw new FormError('自分が名簿にいません')
  }

  return {
    id: newFormId(),
    question,
    choices,
    allowNote: options.allowNote,
    dueAt: options.dueAt,
    recipient: { userId: me.userId, ecdhPublic: me.ecdhPublic },
  }
}

/** 締切を過ぎているか。締切が無いフォームは閉じない。 */
export function isClosed(form: FormDefinition, now: Date = new Date()): boolean {
  if (!form.dueAt) return false
  return Date.parse(form.dueAt) <= now.getTime()
}

export function buildResponse(options: {
  session: Session
  formId: string
  messageId: string
  choice: string
  note: string
  now?: Date
}): FormResponse {
  const choice = options.choice.trim()
  if (choice.length === 0) {
    throw new FormError('回答を選んでください')
  }
  return {
    kind: 'form-response',
    formId: options.formId,
    messageId: options.messageId,
    userId: options.session.userId,
    displayName: options.session.displayName,
    choice,
    note: options.note.trim(),
    at: (options.now ?? new Date()).toISOString(),
  }
}

export function isFormResponse(body: Bytes): boolean {
  try {
    return (JSON.parse(fromUtf8(body)) as { kind?: string }).kind === 'form-response'
  } catch {
    return false
  }
}

export function parseFormResponse(body: Bytes): FormResponse {
  const parsed = JSON.parse(fromUtf8(body)) as FormResponse
  if (parsed.kind !== 'form-response' || typeof parsed.formId !== 'string') {
    throw new FormError('フォームの回答として読めません')
  }
  return parsed
}

export interface Tally {
  answered: number
  counts: Array<{ choice: string; count: number }>
}

/**
 * 選択肢ごとに数える。
 * 同じ人が二度答えたら後のものだけを数える。押し直しは訂正であって2票ではない。
 */
export function tally(
  choices: string[],
  answers: Array<{ choice: string; userId: string }>,
): Tally {
  const latest = new Map<string, string>()
  for (const answer of answers) {
    latest.set(answer.userId, answer.choice)
  }
  const picked = [...latest.values()]
  return {
    answered: latest.size,
    counts: choices.map((choice) => ({
      choice,
      count: picked.filter((value) => value === choice).length,
    })),
  }
}
