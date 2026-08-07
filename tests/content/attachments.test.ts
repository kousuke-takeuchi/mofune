import { describe, it, expect } from 'vitest'
import {
  AttachmentFormatError,
  newFileId,
  openAttachment,
  sealAttachment,
} from '../../src/content/attachments'
import { generateAesKey, sha256 } from '../../src/crypto/symmetric'
import { readKeyIds, sealEnvelopeFor } from '../../src/crypto/envelope'
import { fromUtf8, toHex, utf8 } from '../../src/crypto/bytes'

const photo = { name: '運動会.jpg', mediaType: 'image/jpeg', bytes: utf8('binary-ish') }

describe('newFileId', () => {
  it('is a random hex id', () => {
    expect(newFileId()).toMatch(/^f_[0-9a-f]{32}$/)
  })

  it('does not repeat', () => {
    expect(newFileId()).not.toBe(newFileId())
  })
})

describe('sealAttachment / openAttachment', () => {
  it('round-trips the bytes, name and media type', async () => {
    const key = await generateAesKey()
    const { ref, sealed } = await sealAttachment(photo, [{ keyId: 'sg_a:v1', key }])
    const opened = await openAttachment(new Map([['sg_a:v1', key]]), sealed)
    expect(opened.name).toBe('運動会.jpg')
    expect(opened.mediaType).toBe('image/jpeg')
    expect(fromUtf8(opened.bytes)).toBe('binary-ish')
    expect(ref.size).toBe(photo.bytes.length)
  })

  it('records the plaintext hash in the reference', async () => {
    const key = await generateAesKey()
    const { ref } = await sealAttachment(photo, [{ keyId: 'sg_a:v1', key }])
    expect(ref.contentHash).toBe(toHex(await sha256(photo.bytes)))
  })

  it('addresses the attachment to every scope it was posted to', async () => {
    const team = await generateAesKey()
    const pickup = await generateAesKey()
    const { sealed } = await sealAttachment(photo, [
      { keyId: 'sg_a:v1', key: team },
      { keyId: 'sg_a_pickup:v1', key: pickup },
    ])
    expect(readKeyIds(sealed)).toEqual(['sg_a:v1', 'sg_a_pickup:v1'])
    expect((await openAttachment(new Map([['sg_a_pickup:v1', pickup]]), sealed)).name).toBe(
      '運動会.jpg',
    )
  })

  it('does not leak the file name, media type or content hash into the ciphertext', async () => {
    const key = await generateAesKey()
    const { ref, sealed } = await sealAttachment(photo, [{ keyId: 'sg_a:v1', key }])
    const raw = new TextDecoder().decode(sealed)
    expect(raw).not.toContain('運動会')
    expect(raw).not.toContain('image/jpeg')
    expect(raw).not.toContain(ref.contentHash)
    expect(raw).not.toContain('binary-ish')
  })

  it('gives every attachment a distinct file id', async () => {
    const key = await generateAesKey()
    const a = await sealAttachment(photo, [{ keyId: 'sg_a:v1', key }])
    const b = await sealAttachment(photo, [{ keyId: 'sg_a:v1', key }])
    expect(a.ref.fileId).not.toBe(b.ref.fileId)
  })

  it('cannot be opened without a matching key', async () => {
    const key = await generateAesKey()
    const { sealed } = await sealAttachment(photo, [{ keyId: 'sg_a:v1', key }])
    const stranger = new Map([['sg_b:v1', await generateAesKey()]])
    await expect(openAttachment(stranger, sealed)).rejects.toThrow()
  })

  it('rejects a payload that is not an attachment', async () => {
    const key = await generateAesKey()
    const bogus = await sealEnvelopeFor([{ keyId: 'sg_a:v1', key }], utf8('{"nope":true}'))
    await expect(openAttachment(new Map([['sg_a:v1', key]]), bogus)).rejects.toThrow(
      AttachmentFormatError,
    )
  })

  it('handles an empty file', async () => {
    const key = await generateAesKey()
    const empty = { name: 'empty.txt', mediaType: 'text/plain', bytes: new Uint8Array(0) }
    const { ref, sealed } = await sealAttachment(empty, [{ keyId: 'sg_a:v1', key }])
    expect(ref.size).toBe(0)
    expect((await openAttachment(new Map([['sg_a:v1', key]]), sealed)).bytes).toHaveLength(0)
  })
})
