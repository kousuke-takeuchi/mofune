import type { MailTemplate } from '../group/group-settings'
import { renderTemplate } from '../group/group-settings'
import type { Recipient } from './recipients'

export class MailtoError extends Error {}

/**
 * mailto: URL の長さの上限(保守的な既定値)。
 *
 * 実際の上限はメーラーと OS に依存し、**実機検証 (検証課題 §16-1) は未了である。**
 * この値を「検証済みの正しい値」として扱わないこと。実機で確かめたら、
 * この定数と §16-1 を同時に更新する。
 */
export const DEFAULT_MAX_URL_LENGTH = 1800

/** これを下回る分割しかできないなら、設定が現実的でない。 */
export const MIN_BATCH_SIZE = 2

export interface MailBatch {
  /** 1 始まり。画面に「(1/3)」と出すため。 */
  index: number
  total: number
  url: string
  recipients: Recipient[]
}

export function buildMailtoUrl(options: {
  to: string
  bcc: string[]
  subject: string
  body: string
}): string {
  const params = new URLSearchParams()
  // 参加者どうしにアドレスを見せないため、宛先は必ず BCC に入れる
  if (options.bcc.length > 0) params.set('bcc', options.bcc.join(','))
  params.set('subject', options.subject)
  params.set('body', options.body)
  return `mailto:${options.to}?${params.toString()}`
}

export function buildMailBatches(options: {
  recipients: Recipient[]
  template: MailTemplate
  groupName: string
  kind: string
  link: string
  to: string
  maxUrlLength?: number
}): MailBatch[] {
  if (options.recipients.length === 0) return []

  const budget = options.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH
  const values = {
    グループ名: options.groupName,
    種別: options.kind,
    リンク: options.link,
  }
  const subject = renderTemplate(options.template.subject, values)
  const body = renderTemplate(options.template.body, values)

  const build = (group: Recipient[]): string =>
    buildMailtoUrl({
      to: options.to,
      bcc: group.map((recipient) => recipient.email),
      subject,
      body,
    })

  const groups: Recipient[][] = []
  let current: Recipient[] = []
  for (const recipient of options.recipients) {
    const candidate = [...current, recipient]
    if (current.length > 0 && build(candidate).length > budget) {
      groups.push(current)
      current = [recipient]
      continue
    }
    current = candidate
  }
  if (current.length > 0) groups.push(current)

  // 1人ぶんでも収まらないなら、これ以上分割しても意味がない
  const tooTight = groups.some(
    (group) => group.length < MIN_BATCH_SIZE && build(group).length > budget,
  )
  if (tooTight) {
    throw new MailtoError(
      `maxUrlLength ${budget} is too small to address even ${MIN_BATCH_SIZE} recipients`,
    )
  }

  return groups.map((group, index) => ({
    index: index + 1,
    total: groups.length,
    url: build(group),
    recipients: group,
  }))
}
