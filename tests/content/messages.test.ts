import { describe, it, expect } from 'vitest'
import {
  MessageFormatError,
  newMessageId,
  openMessage,
  sealMessage,
} from '../../src/content/messages'
import type { MessageContent } from '../../src/content/messages'
import { generateAesKey } from '../../src/crypto/symmetric'
import { readKeyIds, sealEnvelopeFor } from '../../src/crypto/envelope'
import { utf8 } from '../../src/crypto/bytes'

const message: MessageContent = {
  id: 'm_0123456789abcdef0123456789abcdef',
  scopes: ['sg_a', 'sg_a_pickup'],
  author: 'u_tanaka',
  at: '2026-08-07T09:12:34.000Z',
  body: '8月14日(金)10時に集合です。持ち物は飲み物とタオル、名札です。',
  attachments: [
    {
      fileId: 'f_00112233445566778899aabbccddeeff',
      name: '案内図.png',
      mediaType: 'image/png',
      size: 1024,
      contentHash: 'a'.repeat(64),
    },
  ],
}

describe('newMessageId', () => {
  it('is a random hex id', () => {
    expect(newMessageId()).toMatch(/^m_[0-9a-f]{32}$/)
  })

  it('does not repeat', () => {
    expect(newMessageId()).not.toBe(newMessageId())
  })
})

describe('sealMessage / openMessage', () => {
  it('round-trips the whole message', async () => {
    const key = await generateAesKey()
    const sealed = await sealMessage(message, [{ keyId: 'sg_a:v1', key }])
    expect(await openMessage(new Map([['sg_a:v1', key]]), sealed)).toEqual(message)
  })

  it('addresses the message to every scope it was posted to', async () => {
    const team = await generateAesKey()
    const pickup = await generateAesKey()
    const sealed = await sealMessage(message, [
      { keyId: 'sg_a:v1', key: team },
      { keyId: 'sg_a_pickup:v1', key: pickup },
    ])
    expect(readKeyIds(sealed)).toEqual(['sg_a:v1', 'sg_a_pickup:v1'])
    expect((await openMessage(new Map([['sg_a_pickup:v1', pickup]]), sealed)).body).toBe(
      message.body,
    )
  })

  it('does not leak the body, author or attachment name into the ciphertext', async () => {
    const key = await generateAesKey()
    const sealed = await sealMessage(message, [{ keyId: 'sg_a:v1', key }])
    const raw = new TextDecoder().decode(sealed)
    expect(raw).not.toContain('集合')
    expect(raw).not.toContain('u_tanaka')
    expect(raw).not.toContain('案内図')
  })

  it('round-trips a message with no attachments', async () => {
    const key = await generateAesKey()
    const plain: MessageContent = { ...message, attachments: [] }
    const sealed = await sealMessage(plain, [{ keyId: 'sg_a:v1', key }])
    expect((await openMessage(new Map([['sg_a:v1', key]]), sealed)).attachments).toEqual([])
  })

  it('cannot be opened by someone outside every addressed scope', async () => {
    const key = await generateAesKey()
    const sealed = await sealMessage(message, [{ keyId: 'sg_a:v1', key }])
    const stranger = new Map([['sg_b:v1', await generateAesKey()]])
    await expect(openMessage(stranger, sealed)).rejects.toThrow()
  })

  it('rejects a payload that is not a message', async () => {
    const key = await generateAesKey()
    const bogus = await sealEnvelopeFor([{ keyId: 'sg_a:v1', key }], utf8('{"nope":true}'))
    await expect(openMessage(new Map([['sg_a:v1', key]]), bogus)).rejects.toThrow(
      MessageFormatError,
    )
  })

  it('rejects a message whose attachments field is not an array', async () => {
    const key = await generateAesKey()
    const broken = await sealEnvelopeFor(
      [{ keyId: 'sg_a:v1', key }],
      utf8(JSON.stringify({ ...message, attachments: 'nope' })),
    )
    await expect(openMessage(new Map([['sg_a:v1', key]]), broken)).rejects.toThrow(
      MessageFormatError,
    )
  })
})
