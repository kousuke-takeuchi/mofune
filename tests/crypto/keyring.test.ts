import { describe, it, expect } from 'vitest'
import {
  KeyUnwrapError,
  keyId,
  wrapKey,
  unwrapKey,
  unlockKeyring,
  serializeKeyringFile,
  parseKeyringFile,
} from '../../src/crypto/keyring'
import type { KeyringFile } from '../../src/crypto/keyring'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { exportAesKey, generateAesKey } from '../../src/crypto/symmetric'
import { toHex } from '../../src/crypto/bytes'

describe('keyring', () => {
  it('formats key ids as scope:vN', () => {
    expect(keyId('sg_a', 3)).toBe('sg_a:v3')
  })

  it('unwraps a key wrapped for the holder', async () => {
    const recipient = await generateEcdhKeyPair()
    const groupKey = await generateAesKey()
    const wrapped = await wrapKey(recipient.publicKey, groupKey)
    const unwrapped = await unwrapKey(wrapped, recipient.privateKey)
    expect(toHex(await exportAesKey(unwrapped))).toBe(toHex(await exportAesKey(groupKey)))
  })

  it('produces a distinct ciphertext each time it wraps the same key', async () => {
    const recipient = await generateEcdhKeyPair()
    const groupKey = await generateAesKey()
    const a = await wrapKey(recipient.publicKey, groupKey)
    const b = await wrapKey(recipient.publicKey, groupKey)
    expect(a.ct).not.toBe(b.ct)
    expect(a.epk).not.toBe(b.epk)
  })

  it('refuses to unwrap with a different private key', async () => {
    const recipient = await generateEcdhKeyPair()
    const stranger = await generateEcdhKeyPair()
    const wrapped = await wrapKey(recipient.publicKey, await generateAesKey())
    await expect(unwrapKey(wrapped, stranger.privateKey)).rejects.toThrow(KeyUnwrapError)
  })

  it('returns only the keys wrapped for the given user', async () => {
    const alice = await generateEcdhKeyPair()
    const bob = await generateEcdhKeyPair()
    const allKey = await generateAesKey()
    const subgroupKey = await generateAesKey()
    const file: KeyringFile = {
      v: 1,
      generation: 1,
      keys: {
        'all:v1': {
          scope: 'all',
          generation: 1,
          wrapped: {
            alice: await wrapKey(alice.publicKey, allKey),
            bob: await wrapKey(bob.publicKey, allKey),
          },
        },
        'sg_a:v1': {
          scope: 'sg_a',
          generation: 1,
          wrapped: { alice: await wrapKey(alice.publicKey, subgroupKey) },
        },
      },
    }

    const aliceKeys = await unlockKeyring(file, 'alice', alice.privateKey)
    expect([...aliceKeys.keys()].sort()).toEqual(['all:v1', 'sg_a:v1'])

    const bobKeys = await unlockKeyring(file, 'bob', bob.privateKey)
    expect([...bobKeys.keys()]).toEqual(['all:v1'])
    expect(toHex(await exportAesKey(bobKeys.get('all:v1') as CryptoKey))).toBe(
      toHex(await exportAesKey(allKey)),
    )
  })

  it('returns an empty map for a user with no wrapped keys', async () => {
    const stranger = await generateEcdhKeyPair()
    const holder = await generateEcdhKeyPair()
    const file: KeyringFile = {
      v: 1,
      generation: 1,
      keys: {
        'all:v1': {
          scope: 'all',
          generation: 1,
          wrapped: { holder: await wrapKey(holder.publicKey, await generateAesKey()) },
        },
      },
    }
    expect((await unlockKeyring(file, 'stranger', stranger.privateKey)).size).toBe(0)
  })

  it('survives a serialize/parse round trip', async () => {
    const holder = await generateEcdhKeyPair()
    const groupKey = await generateAesKey()
    const file: KeyringFile = {
      v: 1,
      generation: 2,
      keys: {
        'all:v2': {
          scope: 'all',
          generation: 2,
          wrapped: { holder: await wrapKey(holder.publicKey, groupKey) },
        },
      },
    }
    const reparsed = parseKeyringFile(serializeKeyringFile(file))
    const keys = await unlockKeyring(reparsed, 'holder', holder.privateKey)
    expect(toHex(await exportAesKey(keys.get('all:v2') as CryptoKey))).toBe(
      toHex(await exportAesKey(groupKey)),
    )
  })
})
