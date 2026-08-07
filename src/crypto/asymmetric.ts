const ECDH_ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' } as const
const ECDSA_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const
const ECDSA_SIGNATURE = { name: 'ECDSA', hash: 'SHA-256' } as const

export interface RawKeyPair {
  /** raw uncompressed point, 65 bytes */
  publicKey: Uint8Array
  /** PKCS#8 */
  privateKey: Uint8Array
}

async function generatePair(
  algorithm: EcKeyGenParams,
  usages: KeyUsage[],
): Promise<RawKeyPair> {
  const pair = (await crypto.subtle.generateKey(algorithm, true, usages)) as CryptoKeyPair
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  }
}

export async function generateEcdhKeyPair(): Promise<RawKeyPair> {
  return generatePair(ECDH_ALGORITHM, ['deriveBits'])
}

export async function generateEcdsaKeyPair(): Promise<RawKeyPair> {
  return generatePair(ECDSA_ALGORITHM, ['sign', 'verify'])
}

export async function importEcdhPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, ECDH_ALGORITHM, false, [])
}

export async function importEcdhPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, ECDH_ALGORITHM, false, ['deriveBits'])
}

export async function importEcdsaPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, ECDSA_ALGORITHM, false, ['verify'])
}

export async function importEcdsaPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, ECDSA_ALGORITHM, false, ['sign'])
}

export async function sign(pkcs8: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await importEcdsaPrivateKey(pkcs8)
  return new Uint8Array(await crypto.subtle.sign(ECDSA_SIGNATURE, key, data))
}

export async function verify(
  rawPublicKey: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  let key: CryptoKey
  try {
    key = await importEcdsaPublicKey(rawPublicKey)
  } catch {
    return false
  }
  return crypto.subtle.verify(ECDSA_SIGNATURE, key, signature, data)
}
