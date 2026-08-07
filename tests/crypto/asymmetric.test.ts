import { describe, it, expect } from 'vitest'
import {
  generateEcdhKeyPair,
  generateEcdsaKeyPair,
  importEcdhPublicKey,
  importEcdhPrivateKey,
  sign,
  verify,
} from '../../src/crypto/asymmetric'
import { utf8 } from '../../src/crypto/bytes'

describe('asymmetric', () => {
  it('generates an ECDH pair with a 65-byte uncompressed public point', async () => {
    const pair = await generateEcdhKeyPair()
    expect(pair.publicKey).toHaveLength(65)
    expect(pair.publicKey[0]).toBe(0x04)
    expect(pair.privateKey.length).toBeGreaterThan(0)
  })

  it('imports both halves of an ECDH pair', async () => {
    const pair = await generateEcdhKeyPair()
    await expect(importEcdhPublicKey(pair.publicKey)).resolves.toBeDefined()
    await expect(importEcdhPrivateKey(pair.privateKey)).resolves.toBeDefined()
  })

  it('derives the same ECDH shared secret from both sides', async () => {
    const alice = await generateEcdhKeyPair()
    const bob = await generateEcdhKeyPair()
    const fromAlice = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importEcdhPublicKey(bob.publicKey) },
      await importEcdhPrivateKey(alice.privateKey),
      256,
    )
    const fromBob = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importEcdhPublicKey(alice.publicKey) },
      await importEcdhPrivateKey(bob.privateKey),
      256,
    )
    expect(new Uint8Array(fromAlice)).toEqual(new Uint8Array(fromBob))
  })

  it('signs and verifies a message', async () => {
    const pair = await generateEcdsaKeyPair()
    const message = utf8('roster contents')
    const signature = await sign(pair.privateKey, message)
    expect(await verify(pair.publicKey, signature, message)).toBe(true)
  })

  it('rejects a signature over different data', async () => {
    const pair = await generateEcdsaKeyPair()
    const signature = await sign(pair.privateKey, utf8('original'))
    expect(await verify(pair.publicKey, signature, utf8('tampered'))).toBe(false)
  })

  it('rejects a signature from a different key', async () => {
    const signer = await generateEcdsaKeyPair()
    const other = await generateEcdsaKeyPair()
    const message = utf8('roster contents')
    const signature = await sign(signer.privateKey, message)
    expect(await verify(other.publicKey, signature, message)).toBe(false)
  })
})
