import type { Bytes } from './bytes'
export const AES_KEY_BYTES = 32
export const IV_BYTES = 12

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
}

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

export async function generateAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
}

export async function importAesKey(raw: Bytes): Promise<CryptoKey> {
  if (raw.length !== AES_KEY_BYTES) {
    throw new Error(`AES key must be ${AES_KEY_BYTES} bytes, got ${raw.length}`)
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
}

export async function exportAesKey(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key))
}

function gcmParams(iv: Bytes, aad?: Bytes): AesGcmParams {
  if (iv.length !== IV_BYTES) {
    throw new Error(`AES-GCM IV must be ${IV_BYTES} bytes, got ${iv.length}`)
  }
  return aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv }
}

export async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Bytes,
  iv: Bytes,
  aad?: Bytes,
): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.encrypt(gcmParams(iv, aad), key, plaintext))
}

export async function aesGcmDecrypt(
  key: CryptoKey,
  ciphertext: Bytes,
  iv: Bytes,
  aad?: Bytes,
): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.decrypt(gcmParams(iv, aad), key, ciphertext))
}
