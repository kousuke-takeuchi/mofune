import type { RosterContents } from '../crypto/roster'
import type { StoredFormResponse } from '../db/group-db'

/**
 * 回答の集計まわりで、端末の中だけで完結する計算。
 *
 * 未回答者を出せるのは作成者の端末だけ。回答は作成者の鍵でしか開かないので、
 * 「送った相手 − 答えた人」を知っているのがそこしかない (設計書 §11.2)。
 */

export interface Responder {
  userId: string
  displayName: string
}

export function pendingResponders(options: {
  roster: RosterContents
  /** お知らせを届けた宛先。 */
  scopes: string[]
  responses: StoredFormResponse[]
  /** 作成者。自分の問いには答えないので外す。 */
  excludeUserId?: string
}): Responder[] {
  const answered = new Set(options.responses.map((response) => response.userId))
  return options.roster.members
    .filter((member) => member.userId !== options.excludeUserId)
    .filter((member) => member.scopes.some((scope) => options.scopes.includes(scope)))
    .filter((member) => !answered.has(member.userId))
    .map((member) => ({ userId: member.userId, displayName: member.displayName }))
}

/**
 * 表計算ソフトが値を式として実行しないように頭を守る。
 * 名前や自由記述に `=` や `+` を書ける以上、書き出す側で止めるしかない。
 */
function defuse(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value
}

function cell(value: string): string {
  const safe = defuse(value)
  return /[",\r\n]/.test(safe) ? `"${safe.split('"').join('""')}"` : safe
}

/** 端末の中の控えをそのまま表にする。どこへも送らない。 */
export function formResponsesToCsv(options: {
  question: string
  responses: StoredFormResponse[]
}): string {
  const rows = [
    ['名前', '回答', 'ひとこと', '受け取った日時'],
    ...options.responses.map((response) => [
      response.displayName,
      response.choice,
      response.note,
      response.at,
    ]),
  ]
  // Excel は CRLF を期待する
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
