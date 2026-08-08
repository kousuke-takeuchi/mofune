import { fromBase32, groupForPrinting, toBase32 } from '../crypto/base32'
import type { Bytes } from '../crypto/bytes'
import { fromBase64, fromUtf8, toBase64, toHex, utf8 } from '../crypto/bytes'
import type { KeystoreContents } from '../crypto/keystore'
import { sha256 } from '../crypto/symmetric'

export class RecoveryKitError extends Error {}

export const RECOVERY_KIT_VERSION = 1
/** チェックサムに使う先頭バイト数。転記ミスを見つけられれば十分。 */
const CHECKSUM_BYTES = 4

export interface RecoveryKit {
  groupId: string
  groupName: string
  userId: string
  /** 印刷用に区切った base32。 */
  code: string
  /** 目視確認用の16進チェックサム。 */
  checksum: string
}

interface KitPayload {
  v: number
  groupId: string
  groupName: string
  userId: string
  ecdhPublic: string
  ecdhPrivate: string
  ecdsaPublic: string
  ecdsaPrivate: string
}

async function checksumOf(body: Bytes): Promise<Bytes> {
  return (await sha256(body)).slice(0, CHECKSUM_BYTES)
}

/**
 * 管理者のルート鍵を紙に出せる形にする。
 *
 * この紙は鍵そのものであり、暗号化していない。復号コードを同じ紙に印刷しても
 * 意味がないためで、安全性は紙の物理的な管理に依存する。画面と印刷物に明記すること。
 */
export async function buildRecoveryKit(options: {
  groupId: string
  groupName: string
  contents: KeystoreContents
}): Promise<RecoveryKit> {
  const payload: KitPayload = {
    v: RECOVERY_KIT_VERSION,
    groupId: options.groupId,
    groupName: options.groupName,
    userId: options.contents.userId,
    ecdhPublic: toBase64(options.contents.ecdh.publicKey),
    ecdhPrivate: toBase64(options.contents.ecdh.privateKey),
    ecdsaPublic: toBase64(options.contents.ecdsa.publicKey),
    ecdsaPrivate: toBase64(options.contents.ecdsa.privateKey),
  }
  const body = utf8(JSON.stringify(payload))
  const checksum = await checksumOf(body)

  const full = new Uint8Array(body.length + checksum.length)
  full.set(body, 0)
  full.set(checksum, body.length)

  return {
    groupId: options.groupId,
    groupName: options.groupName,
    userId: options.contents.userId,
    code: groupForPrinting(toBase32(full)),
    checksum: toHex(checksum),
  }
}

export async function parseRecoveryKit(
  text: string,
): Promise<{ groupId: string; groupName: string; userId: string; contents: KeystoreContents }> {
  let decoded: Bytes
  try {
    decoded = fromBase32(text)
  } catch {
    throw new RecoveryKitError('the recovery code contains characters that are not valid')
  }
  if (decoded.length <= CHECKSUM_BYTES) {
    throw new RecoveryKitError('the recovery code is too short')
  }

  const body = decoded.slice(0, decoded.length - CHECKSUM_BYTES)
  const given = decoded.slice(decoded.length - CHECKSUM_BYTES)
  const expected = await checksumOf(body)
  if (toHex(given) !== toHex(expected)) {
    // 転記ミスに気づかせる。誤ったまま「復元できた」と思わせるほうが危険。
    throw new RecoveryKitError('the recovery code does not match its checksum; check for typos')
  }

  let payload: KitPayload
  try {
    payload = JSON.parse(fromUtf8(body)) as KitPayload
  } catch {
    throw new RecoveryKitError('the recovery code does not contain a recovery kit')
  }
  if (payload.v !== RECOVERY_KIT_VERSION || typeof payload.userId !== 'string') {
    throw new RecoveryKitError('unsupported recovery kit version')
  }

  return {
    groupId: payload.groupId,
    groupName: payload.groupName,
    userId: payload.userId,
    contents: {
      userId: payload.userId,
      ecdh: {
        publicKey: fromBase64(payload.ecdhPublic),
        privateKey: fromBase64(payload.ecdhPrivate),
      },
      ecdsa: {
        publicKey: fromBase64(payload.ecdsaPublic),
        privateKey: fromBase64(payload.ecdsaPrivate),
      },
    },
  }
}
