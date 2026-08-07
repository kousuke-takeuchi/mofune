import { describe, it, expect } from 'vitest'
import {
  InvalidPasswordError,
  createKeystore,
  unlockKeystore,
  parseKeystoreFile,
  serializeKeystoreFile,
} from '../../src/crypto/keystore'
import type { KeystoreContents } from '../../src/crypto/keystore'
import { generateEcdhKeyPair, generateEcdsaKeyPair } from '../../src/crypto/asymmetric'
import { TEST_KDF } from '../../src/crypto/kdf'
import { toHex } from '../../src/crypto/bytes'

async function sampleContents(): Promise<KeystoreContents> {
  return {
    userId: 'u_0123456789abcdef',
    ecdh: await generateEcdhKeyPair(),
    ecdsa: await generateEcdsaKeyPair(),
  }
}

describe('keystore', () => {
  it('round-trips the contents with the correct password', async () => {
    const contents = await sampleContents()
    const file = await createKeystore(contents, 'tulip-anchor-mellow-drift', 'pep', TEST_KDF)
    const unlocked = await unlockKeystore(file, 'tulip-anchor-mellow-drift', 'pep')
    expect(unlocked.userId).toBe(contents.userId)
    expect(toHex(unlocked.ecdh.privateKey)).toBe(toHex(contents.ecdh.privateKey))
    expect(toHex(unlocked.ecdh.publicKey)).toBe(toHex(contents.ecdh.publicKey))
    expect(toHex(unlocked.ecdsa.privateKey)).toBe(toHex(contents.ecdsa.privateKey))
  })

  it('rejects a wrong password', async () => {
    const file = await createKeystore(await sampleContents(), 'right', 'pep', TEST_KDF)
    await expect(unlockKeystore(file, 'wrong', 'pep')).rejects.toThrow(InvalidPasswordError)
  })

  it('rejects a wrong pepper', async () => {
    const file = await createKeystore(await sampleContents(), 'right', 'pep', TEST_KDF)
    await expect(unlockKeystore(file, 'right', 'other')).rejects.toThrow(InvalidPasswordError)
  })

  it('stores the KDF parameters and a fresh salt in the file', async () => {
    const a = await createKeystore(await sampleContents(), 'pass', 'pep', TEST_KDF)
    const b = await createKeystore(await sampleContents(), 'pass', 'pep', TEST_KDF)
    expect(a.kdf.iterations).toBe(TEST_KDF.iterations)
    expect(a.kdf.memorySize).toBe(TEST_KDF.memorySize)
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
  })

  it('does not leak the private key or user id into the serialized form', async () => {
    const contents = await sampleContents()
    const file = await createKeystore(contents, 'pass', 'pep', TEST_KDF)
    const text = new TextDecoder().decode(serializeKeystoreFile(file))
    expect(text).not.toContain(toHex(contents.ecdh.privateKey))
    expect(text).not.toContain(contents.userId)
  })

  it('survives a serialize/parse round trip', async () => {
    const contents = await sampleContents()
    const file = await createKeystore(contents, 'pass', 'pep', TEST_KDF)
    const reparsed = parseKeystoreFile(serializeKeystoreFile(file))
    const unlocked = await unlockKeystore(reparsed, 'pass', 'pep')
    expect(unlocked.userId).toBe(contents.userId)
  })

  it('rejects a file with an unknown version', async () => {
    const file = await createKeystore(await sampleContents(), 'pass', 'pep', TEST_KDF)
    const broken = JSON.stringify({ ...file, v: 99 })
    expect(() => parseKeystoreFile(new TextEncoder().encode(broken))).toThrow(/version/)
  })
})
