import { describe, it, expect } from 'vitest'
import {
  EnvelopeError,
  DecryptionError,
  parseEnvelope,
  readKeyIds,
  sealEnvelope,
  sealEnvelopeFor,
  openEnvelope,
  openEnvelopeWithKey,
} from '../../src/crypto/envelope'
import { generateAesKey } from '../../src/crypto/symmetric'
import { utf8 } from '../../src/crypto/bytes'

const headerLength = (keyIds: string[]): number =>
  4 + 1 + 1 + keyIds.reduce((sum, id) => sum + 1 + utf8(id).length + 1 + 60, 0) + 12

describe('envelope', () => {
  it('round-trips a plaintext for a single recipient', async () => {
    const key = await generateAesKey()
    const sealed = await sealEnvelope(key, 'sg_a:v1', utf8('おしらせ本文'))
    expect(await openEnvelopeWithKey(key, sealed)).toEqual(utf8('おしらせ本文'))
  })

  it('opens with any one of the addressed scope keys', async () => {
    const teamKey = await generateAesKey()
    const pickupKey = await generateAesKey()
    const sealed = await sealEnvelopeFor(
      [
        { keyId: 'sg_a:v1', key: teamKey },
        { keyId: 'sg_a_pickup:v1', key: pickupKey },
      ],
      utf8('来週の集まりについて'),
    )
    const holdsTeam = new Map([['sg_a:v1', teamKey]])
    const holdsPickup = new Map([['sg_a_pickup:v1', pickupKey]])
    expect(await openEnvelope(holdsTeam, sealed)).toEqual(utf8('来週の集まりについて'))
    expect(await openEnvelope(holdsPickup, sealed)).toEqual(utf8('来週の集まりについて'))
  })

  it('exposes the key ids without holding any key', async () => {
    const sealed = await sealEnvelopeFor(
      [
        { keyId: 'all:v3', key: await generateAesKey() },
        { keyId: 'staff:v3', key: await generateAesKey() },
      ],
      utf8('body'),
    )
    expect(readKeyIds(sealed)).toEqual(['all:v3', 'staff:v3'])
  })

  it('parses the structural fields', async () => {
    const sealed = await sealEnvelopeFor(
      [
        { keyId: 'all:v1', key: await generateAesKey() },
        { keyId: 'sg_a:v1', key: await generateAesKey() },
      ],
      utf8('body'),
    )
    const parsed = parseEnvelope(sealed)
    expect(parsed.recipients.map((r) => r.keyId)).toEqual(['all:v1', 'sg_a:v1'])
    expect(parsed.recipients[0]?.wrapped).toHaveLength(60)
    expect(parsed.iv).toHaveLength(12)
    expect(parsed.header).toHaveLength(headerLength(['all:v1', 'sg_a:v1']))
    expect(parsed.ciphertext.length).toBeGreaterThan(0)
  })

  it('uses a fresh content key for every seal', async () => {
    const key = await generateAesKey()
    const a = await sealEnvelope(key, 'all:v1', utf8('body'))
    const b = await sealEnvelope(key, 'all:v1', utf8('body'))
    expect(parseEnvelope(a).ciphertext).not.toEqual(parseEnvelope(b).ciphertext)
    expect(parseEnvelope(a).recipients[0]?.wrapped).not.toEqual(
      parseEnvelope(b).recipients[0]?.wrapped,
    )
  })

  it('rejects bytes without the magic prefix', () => {
    expect(() => parseEnvelope(new Uint8Array(120))).toThrow(EnvelopeError)
  })

  it('rejects a truncated envelope', async () => {
    const sealed = await sealEnvelope(await generateAesKey(), 'all:v1', utf8('body'))
    expect(() => parseEnvelope(sealed.subarray(0, 20))).toThrow(EnvelopeError)
  })

  it('rejects an empty recipient list', async () => {
    await expect(sealEnvelopeFor([], utf8('body'))).rejects.toThrow(EnvelopeError)
  })

  it('rejects an empty key id', async () => {
    await expect(sealEnvelope(await generateAesKey(), '', utf8('body'))).rejects.toThrow(
      EnvelopeError,
    )
  })

  it('rejects duplicate key ids', async () => {
    const key = await generateAesKey()
    await expect(
      sealEnvelopeFor([{ keyId: 'all:v1', key }, { keyId: 'all:v1', key }], utf8('body')),
    ).rejects.toThrow(EnvelopeError)
  })

  it('detects tampering with the plaintext key id header', async () => {
    const key = await generateAesKey()
    const sealed = await sealEnvelope(key, 'all:v1', utf8('body'))
    // 先頭 recipient の keyId 1 バイト目を書き換える
    sealed[7] = sealed[7] === 0x61 ? 0x62 : 0x61
    await expect(openEnvelopeWithKey(key, sealed)).rejects.toThrow(DecryptionError)
  })

  it('fails when the caller holds none of the addressed keys', async () => {
    const sealed = await sealEnvelope(await generateAesKey(), 'all:v1', utf8('body'))
    const stranger = new Map([['sg_a:v1', await generateAesKey()]])
    await expect(openEnvelope(stranger, sealed)).rejects.toThrow(DecryptionError)
  })

  it('fails when the held key id matches but the key is wrong', async () => {
    const sealed = await sealEnvelope(await generateAesKey(), 'all:v1', utf8('body'))
    const wrong = new Map([['all:v1', await generateAesKey()]])
    await expect(openEnvelope(wrong, sealed)).rejects.toThrow(DecryptionError)
  })
})
