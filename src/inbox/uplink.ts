import type { Bytes } from '../crypto/bytes'
import { fromBase64, fromUtf8, toBase64, utf8 } from '../crypto/bytes'
import { openEnvelope, sealEnvelopeFor } from '../crypto/envelope'
import type { WrappedKey } from '../crypto/keyring'
import { unwrapKey, wrapKey } from '../crypto/keyring'
import type { RosterContents } from '../crypto/roster'
import { generateAesKey } from '../crypto/symmetric'

export class UplinkFormatError extends Error {}
export class NoRecipientError extends Error {}

export const UPLINK_VERSION = 1
/** 本体を包むエンベロープの keyId。CEK は下の keys に入っているので固定でよい。 */
const UPLINK_KEY_ID = 'uplink'

export interface UplinkRecipient {
  userId: string
  /** base64, raw ECDH public key */
  ecdhPublic: string
}

export interface UplinkPacket {
  v: number
  /** userId -> CEK をその人の公開鍵でラップしたもの */
  keys: Record<string, WrappedKey>
  /** base64 のエンベロープ */
  envelope: string
}

/**
 * 名簿の公開部から担当者と管理者を拾う。参加者はここに入らない。
 * 公開部には全員の ECDH 公開鍵があるので、参加者も名簿だけで宛先を解決できる。
 */
export function staffRecipients(roster: RosterContents): UplinkRecipient[] {
  return roster.members
    .filter((member) => member.role === 'admin' || member.role === 'staff')
    .map((member) => ({ userId: member.userId, ecdhPublic: member.ecdhPublic }))
}

/**
 * 受信者それぞれの公開鍵へ封緘する。
 * staff スコープ鍵を使わないのは、参加者にその鍵を渡すと名簿の連絡先まで
 * 復号できてしまうため(設計書 §4.6)。
 */
export async function sealForRecipients(
  recipients: UplinkRecipient[],
  plaintext: Bytes,
): Promise<Bytes> {
  if (recipients.length === 0) {
    throw new NoRecipientError('an uplink needs at least one recipient')
  }
  const cek = await generateAesKey()
  const envelope = await sealEnvelopeFor([{ keyId: UPLINK_KEY_ID, key: cek }], plaintext)

  const keys: Record<string, WrappedKey> = {}
  for (const recipient of recipients) {
    keys[recipient.userId] = await wrapKey(fromBase64(recipient.ecdhPublic), cek)
  }

  const packet: UplinkPacket = {
    v: UPLINK_VERSION,
    keys,
    envelope: toBase64(envelope),
  }
  return utf8(JSON.stringify(packet))
}

export async function openAsRecipient(
  userId: string,
  ecdhPrivate: Bytes,
  bytes: Bytes,
): Promise<Bytes> {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new UplinkFormatError('uplink packet is not valid JSON')
  }
  const packet = parsed as UplinkPacket
  if (packet === null || typeof packet !== 'object' || typeof packet.envelope !== 'string') {
    throw new UplinkFormatError('uplink packet is missing required fields')
  }
  if (packet.v !== UPLINK_VERSION) {
    throw new UplinkFormatError(`unsupported uplink version ${String(packet.v)}`)
  }
  const wrapped = packet.keys?.[userId]
  if (!wrapped) {
    throw new UplinkFormatError(`uplink packet is not addressed to "${userId}"`)
  }
  const cek = await unwrapKey(wrapped, ecdhPrivate)
  return openEnvelope(new Map([[UPLINK_KEY_ID, cek]]), fromBase64(packet.envelope))
}
