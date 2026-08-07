import type { Bytes } from '../crypto/bytes'
import { fromBase64, fromUtf8, toBase64, toHex, utf8 } from '../crypto/bytes'
import type { SealTarget } from '../crypto/envelope'
import { openEnvelope, sealEnvelopeFor } from '../crypto/envelope'
import { randomBytes, sha256 } from '../crypto/symmetric'

export class AttachmentFormatError extends Error {}

/** メッセージから添付を指すための参照。メッセージ本体の中(暗号化の内側)に入る。 */
export interface AttachmentRef {
  fileId: string
  name: string
  mediaType: string
  size: number
  /** 平文の SHA-256 (hex)。将来の重複排除用。外には出さない。 */
  contentHash: string
}

export interface OpenedAttachment {
  name: string
  mediaType: string
  bytes: Bytes
}

interface AttachmentPayload {
  name: string
  mediaType: string
  contentHash: string
  /** base64。JSON に載せるためやむを得ず膨らむが、暗号化の内側なので秘匿性は保たれる。 */
  data: string
}

export function newFileId(): string {
  return `f_${toHex(randomBytes(16))}`
}

/**
 * 添付を封緘する。ファイル名・MIME タイプ・平文ハッシュも暗号化の内側に入れる。
 * 平文で外に出るのはオブジェクトのサイズと更新時刻だけ(要件書 §5.3)。
 */
export async function sealAttachment(
  input: { name: string; mediaType: string; bytes: Bytes },
  targets: SealTarget[],
): Promise<{ ref: AttachmentRef; sealed: Bytes }> {
  const contentHash = toHex(await sha256(input.bytes))
  const payload: AttachmentPayload = {
    name: input.name,
    mediaType: input.mediaType,
    contentHash,
    data: toBase64(input.bytes),
  }
  const sealed = await sealEnvelopeFor(targets, utf8(JSON.stringify(payload)))
  return {
    ref: {
      fileId: newFileId(),
      name: input.name,
      mediaType: input.mediaType,
      size: input.bytes.length,
      contentHash,
    },
    sealed,
  }
}

export async function openAttachment(
  keys: ReadonlyMap<string, CryptoKey>,
  bytes: Bytes,
): Promise<OpenedAttachment> {
  const plaintext = await openEnvelope(keys, bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(plaintext))
  } catch {
    throw new AttachmentFormatError('attachment body is not valid JSON')
  }
  const payload = parsed as AttachmentPayload
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.name !== 'string' ||
    typeof payload.mediaType !== 'string' ||
    typeof payload.data !== 'string'
  ) {
    throw new AttachmentFormatError('attachment is missing required fields')
  }
  return {
    name: payload.name,
    mediaType: payload.mediaType,
    bytes: fromBase64(payload.data),
  }
}
