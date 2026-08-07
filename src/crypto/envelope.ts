import { concat, equal, fromUtf8, utf8 } from './bytes'
import {
  IV_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  exportAesKey,
  generateAesKey,
  importAesKey,
  randomBytes,
} from './symmetric'

export class EnvelopeError extends Error {}
export class DecryptionError extends Error {}

export const ENVELOPE_MAGIC = utf8('MFN1')
export const ENVELOPE_VERSION = 2

const MAGIC_LENGTH = 4
/** magic + version + recipient count */
const RECIPIENTS_OFFSET = MAGIC_LENGTH + 2
/** IV(12) + AES-GCM(CEK 32B) の暗号文 32 + 認証タグ 16 */
const WRAPPED_LENGTH = IV_BYTES + 32 + 16

export interface EnvelopeRecipient {
  keyId: string
  /** IV(12) || AES-GCM(scopeKey, CEK, AAD=keyId) */
  wrapped: Uint8Array
}

export interface ParsedEnvelope {
  recipients: EnvelopeRecipient[]
  iv: Uint8Array
  ciphertext: Uint8Array
  /** magic から body IV までの平文ヘッダ。本体の AAD として使う。 */
  header: Uint8Array
}

export interface SealTarget {
  keyId: string
  key: CryptoKey
}

async function wrapContentKey(target: SealTarget, cek: CryptoKey): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES)
  const sealed = await aesGcmEncrypt(target.key, await exportAesKey(cek), iv, utf8(target.keyId))
  return concat(iv, sealed)
}

async function unwrapContentKey(
  recipient: EnvelopeRecipient,
  scopeKey: CryptoKey,
): Promise<CryptoKey> {
  const raw = await aesGcmDecrypt(
    scopeKey,
    recipient.wrapped.subarray(IV_BYTES),
    recipient.wrapped.subarray(0, IV_BYTES),
    utf8(recipient.keyId),
  )
  return importAesKey(raw)
}

export function parseEnvelope(bytes: Uint8Array): ParsedEnvelope {
  if (bytes.length < RECIPIENTS_OFFSET) {
    throw new EnvelopeError('envelope is too short')
  }
  if (!equal(bytes.subarray(0, MAGIC_LENGTH), ENVELOPE_MAGIC)) {
    throw new EnvelopeError('envelope magic does not match')
  }
  const version = bytes[MAGIC_LENGTH] as number
  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeError(`unsupported envelope version ${version}`)
  }
  const count = bytes[MAGIC_LENGTH + 1] as number
  if (count === 0) {
    throw new EnvelopeError('envelope has no recipients')
  }

  const recipients: EnvelopeRecipient[] = []
  let offset = RECIPIENTS_OFFSET
  for (let i = 0; i < count; i += 1) {
    if (offset >= bytes.length) throw new EnvelopeError('envelope is truncated')
    const keyIdLength = bytes[offset] as number
    if (keyIdLength === 0) throw new EnvelopeError('envelope has an empty keyId')
    offset += 1
    const keyIdEnd = offset + keyIdLength
    if (keyIdEnd >= bytes.length) throw new EnvelopeError('envelope is truncated')
    const keyId = fromUtf8(bytes.subarray(offset, keyIdEnd))
    const wrappedLength = bytes[keyIdEnd] as number
    if (wrappedLength !== WRAPPED_LENGTH) {
      throw new EnvelopeError(`wrapped key must be ${WRAPPED_LENGTH} bytes, got ${wrappedLength}`)
    }
    const wrappedEnd = keyIdEnd + 1 + wrappedLength
    if (wrappedEnd > bytes.length) throw new EnvelopeError('envelope is truncated')
    recipients.push({ keyId, wrapped: bytes.subarray(keyIdEnd + 1, wrappedEnd) })
    offset = wrappedEnd
  }

  const ivEnd = offset + IV_BYTES
  if (bytes.length <= ivEnd) {
    throw new EnvelopeError('envelope is truncated')
  }
  return {
    recipients,
    iv: bytes.subarray(offset, ivEnd),
    ciphertext: bytes.subarray(ivEnd),
    header: bytes.subarray(0, ivEnd),
  }
}

export function readKeyIds(bytes: Uint8Array): string[] {
  return parseEnvelope(bytes).recipients.map((recipient) => recipient.keyId)
}

export async function sealEnvelopeFor(
  targets: SealTarget[],
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (targets.length < 1 || targets.length > 255) {
    throw new EnvelopeError(`envelope needs 1-255 recipients, got ${targets.length}`)
  }
  const keyIds = new Set(targets.map((target) => target.keyId))
  if (keyIds.size !== targets.length) {
    throw new EnvelopeError('envelope recipients must have distinct keyIds')
  }

  const cek = await generateAesKey()
  const parts: Uint8Array[] = [ENVELOPE_MAGIC, new Uint8Array([ENVELOPE_VERSION, targets.length])]
  for (const target of targets) {
    const encodedKeyId = utf8(target.keyId)
    if (encodedKeyId.length < 1 || encodedKeyId.length > 255) {
      throw new EnvelopeError(
        `keyId must encode to 1-255 bytes, got ${encodedKeyId.length}`,
      )
    }
    const wrapped = await wrapContentKey(target, cek)
    parts.push(
      new Uint8Array([encodedKeyId.length]),
      encodedKeyId,
      new Uint8Array([wrapped.length]),
      wrapped,
    )
  }
  parts.push(randomBytes(IV_BYTES))

  const header = concat(...parts)
  const iv = header.subarray(header.length - IV_BYTES)
  return concat(header, await aesGcmEncrypt(cek, plaintext, iv, header))
}

export async function sealEnvelope(
  key: CryptoKey,
  keyId: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  return sealEnvelopeFor([{ keyId, key }], plaintext)
}

export async function openEnvelope(
  keys: ReadonlyMap<string, CryptoKey>,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const envelope = parseEnvelope(bytes)
  for (const recipient of envelope.recipients) {
    const scopeKey = keys.get(recipient.keyId)
    if (!scopeKey) continue
    try {
      const cek = await unwrapContentKey(recipient, scopeKey)
      return await aesGcmDecrypt(cek, envelope.ciphertext, envelope.iv, envelope.header)
    } catch {
      // この鍵では開けない。次の宛先を試す。
    }
  }
  throw new DecryptionError(
    `no held key could open this envelope (addressed to ${envelope.recipients
      .map((recipient) => recipient.keyId)
      .join(', ')})`,
  )
}

/** 単一スコープのオブジェクト用。keyId を問わず手持ちの鍵で総当たりする。 */
export async function openEnvelopeWithKey(
  key: CryptoKey,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const envelope = parseEnvelope(bytes)
  const keys = new Map(envelope.recipients.map((recipient) => [recipient.keyId, key]))
  return openEnvelope(keys, bytes)
}
