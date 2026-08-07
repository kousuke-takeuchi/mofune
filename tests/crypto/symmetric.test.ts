import { describe, it, expect } from 'vitest'
import {
  AES_KEY_BYTES,
  IV_BYTES,
  randomBytes,
  sha256,
  generateAesKey,
  importAesKey,
  exportAesKey,
  aesGcmEncrypt,
  aesGcmDecrypt,
} from '../../src/crypto/symmetric'
import { utf8, toHex } from '../../src/crypto/bytes'

describe('symmetric', () => {
  it('generates random bytes of the requested length', () => {
    expect(randomBytes(24)).toHaveLength(24)
    expect(toHex(randomBytes(16))).not.toBe(toHex(randomBytes(16)))
  })

  it('computes the known SHA-256 digest of "abc"', async () => {
    expect(toHex(await sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('exports a generated AES key as 32 bytes', async () => {
    expect(await exportAesKey(await generateAesKey())).toHaveLength(AES_KEY_BYTES)
  })

  it('round-trips a message through AES-GCM', async () => {
    const key = await generateAesKey()
    const iv = randomBytes(IV_BYTES)
    const plaintext = utf8('欠席連絡です')
    const ciphertext = await aesGcmEncrypt(key, plaintext, iv)
    expect(ciphertext).not.toEqual(plaintext)
    expect(await aesGcmDecrypt(key, ciphertext, iv)).toEqual(plaintext)
  })

  it('binds additional authenticated data', async () => {
    const key = await generateAesKey()
    const iv = randomBytes(IV_BYTES)
    const ciphertext = await aesGcmEncrypt(key, utf8('body'), iv, utf8('header'))
    await expect(aesGcmDecrypt(key, ciphertext, iv, utf8('tampered'))).rejects.toThrow()
  })

  it('fails to decrypt with the wrong key', async () => {
    const iv = randomBytes(IV_BYTES)
    const ciphertext = await aesGcmEncrypt(await generateAesKey(), utf8('body'), iv)
    await expect(aesGcmDecrypt(await generateAesKey(), ciphertext, iv)).rejects.toThrow()
  })

  it('imports a raw key that decrypts what the exported key encrypted', async () => {
    const key = await generateAesKey()
    const iv = randomBytes(IV_BYTES)
    const ciphertext = await aesGcmEncrypt(key, utf8('body'), iv)
    const reimported = await importAesKey(await exportAesKey(key))
    expect(await aesGcmDecrypt(reimported, ciphertext, iv)).toEqual(utf8('body'))
  })
})
