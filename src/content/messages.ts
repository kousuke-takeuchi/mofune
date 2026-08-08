import type { Bytes } from '../crypto/bytes'
import { fromUtf8, toHex, utf8 } from '../crypto/bytes'
import type { SealTarget } from '../crypto/envelope'
import { openEnvelope, sealEnvelopeFor } from '../crypto/envelope'
import { randomBytes } from '../crypto/symmetric'
import type { AttachmentRef } from './attachments'
import type { FormDefinition } from './forms'

export class MessageFormatError extends Error {}

export interface MessageContent {
  id: string
  /** 配信先スコープ。世代を含まない素のスコープ id。 */
  scopes: string[]
  author: string
  at: string
  /** 一覧で太字に出す見出し。付けない投稿もある。 */
  title?: string
  body: string
  attachments: AttachmentRef[]
  /** 埋め込みフォーム。お知らせと同じ鍵で封緘されるので、読める人だけが見える。 */
  form?: FormDefinition
}

export function newMessageId(): string {
  return `m_${toHex(randomBytes(16))}`
}

export async function sealMessage(
  message: MessageContent,
  targets: SealTarget[],
): Promise<Bytes> {
  return sealEnvelopeFor(targets, utf8(JSON.stringify(message)))
}

export async function openMessage(
  keys: ReadonlyMap<string, CryptoKey>,
  bytes: Bytes,
): Promise<MessageContent> {
  const plaintext = await openEnvelope(keys, bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(plaintext))
  } catch {
    throw new MessageFormatError('message body is not valid JSON')
  }
  const message = parsed as MessageContent
  if (
    message === null ||
    typeof message !== 'object' ||
    typeof message.id !== 'string' ||
    typeof message.author !== 'string' ||
    typeof message.body !== 'string'
  ) {
    throw new MessageFormatError('message is missing required fields')
  }
  if (!Array.isArray(message.attachments) || !Array.isArray(message.scopes)) {
    throw new MessageFormatError('message scopes and attachments must be arrays')
  }
  return message
}
