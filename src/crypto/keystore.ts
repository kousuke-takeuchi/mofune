import type { Bytes } from './bytes'
import type { RawKeyPair } from './asymmetric'
import { fromBase64, fromUtf8, toBase64, utf8 } from './bytes'
import { DecryptionError, openEnvelopeWithKey, sealEnvelope } from './envelope'
import type { KdfParams } from './kdf'
import { PRODUCTION_KDF, SALT_BYTES, deriveKek } from './kdf'
import { randomBytes } from './symmetric'

export class InvalidPasswordError extends Error {}
export class KeystoreFormatError extends Error {}

export const KEYSTORE_VERSION = 1
export const KEYSTORE_KEY_ID = 'keystore'

export interface KeystoreContents {
  userId: string
  ecdh: RawKeyPair
  ecdsa: RawKeyPair
}

export interface KeystoreFile {
  v: number
  kdf: {
    algorithm: 'argon2id'
    iterations: number
    memorySize: number
    parallelism: number
    hashLength: number
    /** base64 */
    salt: string
  }
  /** base64 のエンベロープ */
  envelope: string
}

interface SerializedContents {
  userId: string
  ecdhPublic: string
  ecdhPrivate: string
  ecdsaPublic: string
  ecdsaPrivate: string
}

export async function createKeystore(
  contents: KeystoreContents,
  password: string,
  pepper: string,
  params: KdfParams = PRODUCTION_KDF,
): Promise<KeystoreFile> {
  const salt = randomBytes(SALT_BYTES)
  const kek = await deriveKek(password, pepper, salt, params)
  const payload: SerializedContents = {
    userId: contents.userId,
    ecdhPublic: toBase64(contents.ecdh.publicKey),
    ecdhPrivate: toBase64(contents.ecdh.privateKey),
    ecdsaPublic: toBase64(contents.ecdsa.publicKey),
    ecdsaPrivate: toBase64(contents.ecdsa.privateKey),
  }
  const envelope = await sealEnvelope(kek, KEYSTORE_KEY_ID, utf8(JSON.stringify(payload)))
  return {
    v: KEYSTORE_VERSION,
    kdf: {
      algorithm: params.algorithm,
      iterations: params.iterations,
      memorySize: params.memorySize,
      parallelism: params.parallelism,
      hashLength: params.hashLength,
      salt: toBase64(salt),
    },
    envelope: toBase64(envelope),
  }
}

export async function unlockKeystore(
  file: KeystoreFile,
  password: string,
  pepper: string,
): Promise<KeystoreContents> {
  const kek = await deriveKek(password, pepper, fromBase64(file.kdf.salt), {
    algorithm: file.kdf.algorithm,
    iterations: file.kdf.iterations,
    memorySize: file.kdf.memorySize,
    parallelism: file.kdf.parallelism,
    hashLength: file.kdf.hashLength,
  })
  let plaintext: Bytes
  try {
    plaintext = await openEnvelopeWithKey(kek, fromBase64(file.envelope))
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw new InvalidPasswordError('keystore could not be unlocked')
    }
    throw error
  }
  const payload = JSON.parse(fromUtf8(plaintext)) as SerializedContents
  return {
    userId: payload.userId,
    ecdh: {
      publicKey: fromBase64(payload.ecdhPublic),
      privateKey: fromBase64(payload.ecdhPrivate),
    },
    ecdsa: {
      publicKey: fromBase64(payload.ecdsaPublic),
      privateKey: fromBase64(payload.ecdsaPrivate),
    },
  }
}

export function serializeKeystoreFile(file: KeystoreFile): Bytes {
  return utf8(JSON.stringify(file))
}

export function parseKeystoreFile(bytes: Bytes): KeystoreFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new KeystoreFormatError('keystore is not valid JSON')
  }
  const file = parsed as KeystoreFile
  if (file === null || typeof file !== 'object') {
    throw new KeystoreFormatError('keystore is not an object')
  }
  if (file.v !== KEYSTORE_VERSION) {
    throw new KeystoreFormatError(`unsupported keystore version ${String(file.v)}`)
  }
  if (typeof file.envelope !== 'string' || file.kdf === null || typeof file.kdf !== 'object') {
    throw new KeystoreFormatError('keystore is missing required fields')
  }
  return file
}
