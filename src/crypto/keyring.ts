import {
  generateEcdhKeyPair,
  importEcdhPrivateKey,
  importEcdhPublicKey,
} from './asymmetric'
import { fromBase64, fromUtf8, toBase64, utf8 } from './bytes'
import {
  IV_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  exportAesKey,
  importAesKey,
  randomBytes,
} from './symmetric'

export class KeyUnwrapError extends Error {}
export class KeyringFormatError extends Error {}

export const KEYRING_VERSION = 1
const HKDF_INFO = utf8('mofune-keywrap-v1')

export interface WrappedKey {
  /** エフェメラル公開鍵 (base64, raw) */
  epk: string
  /** base64 */
  iv: string
  /** base64 */
  ct: string
}

export interface KeyringEntry {
  scope: string
  generation: number
  /** userId -> ラップ済みスコープ鍵 */
  wrapped: Record<string, WrappedKey>
}

export interface KeyringFile {
  v: number
  generation: number
  /** keyId -> エントリ */
  keys: Record<string, KeyringEntry>
}

export function keyId(scope: string, generation: number): string {
  return `${scope}:v${generation}`
}

async function deriveWrappingKey(
  privatePkcs8: Uint8Array,
  publicRaw: Uint8Array,
  hkdfSalt: Uint8Array,
): Promise<CryptoKey> {
  const sharedBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importEcdhPublicKey(publicRaw) },
      await importEcdhPrivateKey(privatePkcs8),
      256,
    ),
  )
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, [
    'deriveBits',
  ])
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: HKDF_INFO },
      hkdfKey,
      256,
    ),
  )
  return importAesKey(derived)
}

export async function wrapKey(
  recipientEcdhPublic: Uint8Array,
  key: CryptoKey,
): Promise<WrappedKey> {
  const ephemeral = await generateEcdhKeyPair()
  const wrappingKey = await deriveWrappingKey(
    ephemeral.privateKey,
    recipientEcdhPublic,
    ephemeral.publicKey,
  )
  const iv = randomBytes(IV_BYTES)
  const ciphertext = await aesGcmEncrypt(wrappingKey, await exportAesKey(key), iv)
  return { epk: toBase64(ephemeral.publicKey), iv: toBase64(iv), ct: toBase64(ciphertext) }
}

export async function unwrapKey(
  wrapped: WrappedKey,
  recipientEcdhPrivate: Uint8Array,
): Promise<CryptoKey> {
  const ephemeralPublic = fromBase64(wrapped.epk)
  try {
    const wrappingKey = await deriveWrappingKey(
      recipientEcdhPrivate,
      ephemeralPublic,
      ephemeralPublic,
    )
    const raw = await aesGcmDecrypt(
      wrappingKey,
      fromBase64(wrapped.ct),
      fromBase64(wrapped.iv),
    )
    return await importAesKey(raw)
  } catch {
    throw new KeyUnwrapError('wrapped key could not be unwrapped with this private key')
  }
}

/** 指定ユーザー宛にラップされている鍵だけを復号して返す。 */
export async function unlockKeyring(
  file: KeyringFile,
  userId: string,
  ecdhPrivate: Uint8Array,
): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>()
  for (const [id, entry] of Object.entries(file.keys)) {
    const wrapped = entry.wrapped[userId]
    if (!wrapped) continue
    keys.set(id, await unwrapKey(wrapped, ecdhPrivate))
  }
  return keys
}

export function serializeKeyringFile(file: KeyringFile): Uint8Array {
  return utf8(JSON.stringify(file))
}

export function parseKeyringFile(bytes: Uint8Array): KeyringFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new KeyringFormatError('keyring is not valid JSON')
  }
  const file = parsed as KeyringFile
  if (file === null || typeof file !== 'object') {
    throw new KeyringFormatError('keyring is not an object')
  }
  if (file.v !== KEYRING_VERSION) {
    throw new KeyringFormatError(`unsupported keyring version ${String(file.v)}`)
  }
  if (file.keys === null || typeof file.keys !== 'object') {
    throw new KeyringFormatError('keyring is missing the keys map')
  }
  return file
}
