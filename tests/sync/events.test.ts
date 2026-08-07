import { describe, it, expect } from 'vitest'
import {
  EventFormatError,
  compareEventIds,
  eventPathFor,
  newEventId,
  openEvent,
  sealEvent,
} from '../../src/sync/events'
import type { GroupEvent } from '../../src/sync/events'
import { generateAesKey } from '../../src/crypto/symmetric'
import { readKeyIds } from '../../src/crypto/envelope'

const event: GroupEvent = {
  id: '20260807T091234Z-a1b2c3d4',
  type: 'MESSAGE_CREATED',
  author: 'u_tanaka',
  at: '2026-08-07T09:12:34.000Z',
  payload: { messageId: 'm_1', scopes: ['sg_a', 'sg_a_pickup'] },
}

describe('newEventId', () => {
  it('starts with the ISO 8601 basic timestamp', () => {
    expect(newEventId(new Date('2026-08-07T09:12:34.000Z'))).toMatch(
      /^20260807T091234Z-[0-9a-f]{8}$/,
    )
  })

  it('is unique for the same instant', () => {
    const now = new Date('2026-08-07T09:12:34.000Z')
    expect(newEventId(now)).not.toBe(newEventId(now))
  })
})

describe('compareEventIds', () => {
  it('orders ids by time', () => {
    const early = '20260807T091234Z-ffffffff'
    const late = '20260807T091235Z-00000000'
    expect(compareEventIds(early, late)).toBeLessThan(0)
    expect(compareEventIds(late, early)).toBeGreaterThan(0)
  })

  it('sorts lexicographically, which is what storage listing gives us', () => {
    const ids = ['20260807T091300Z-b', '20260806T235959Z-a', '20260807T091234Z-c']
    expect([...ids].sort(compareEventIds)).toEqual([
      '20260806T235959Z-a',
      '20260807T091234Z-c',
      '20260807T091300Z-b',
    ])
  })

  it('is stable for identical ids', () => {
    expect(compareEventIds(event.id, event.id)).toBe(0)
  })
})

describe('eventPathFor', () => {
  it('places events under the group events prefix', () => {
    expect(eventPathFor('midori', event.id)).toBe(
      'midori/events/20260807T091234Z-a1b2c3d4.enc',
    )
  })
})

describe('sealEvent / openEvent', () => {
  it('round-trips an event for a scope key holder', async () => {
    const key = await generateAesKey()
    const sealed = await sealEvent(event, [{ keyId: 'sg_a:v1', key }])
    expect(await openEvent(new Map([['sg_a:v1', key]]), sealed)).toEqual(event)
  })

  it('addresses the event to every scope it was posted to', async () => {
    const team = await generateAesKey()
    const pickup = await generateAesKey()
    const sealed = await sealEvent(event, [
      { keyId: 'sg_a:v1', key: team },
      { keyId: 'sg_a_pickup:v1', key: pickup },
    ])
    expect(readKeyIds(sealed)).toEqual(['sg_a:v1', 'sg_a_pickup:v1'])
    expect(await openEvent(new Map([['sg_a_pickup:v1', pickup]]), sealed)).toEqual(event)
  })

  it('does not leak the author or the payload into the ciphertext', async () => {
    const key = await generateAesKey()
    const sealed = await sealEvent(event, [{ keyId: 'sg_a:v1', key }])
    const raw = new TextDecoder().decode(sealed)
    expect(raw).not.toContain('u_tanaka')
    expect(raw).not.toContain('m_1')
  })

  it('cannot be opened without a matching key', async () => {
    const sealed = await sealEvent(event, [{ keyId: 'sg_a:v1', key: await generateAesKey() }])
    const stranger = new Map([['sg_b:v1', await generateAesKey()]])
    await expect(openEvent(stranger, sealed)).rejects.toThrow()
  })

  it('rejects an event whose decrypted body is not a valid event', async () => {
    const key = await generateAesKey()
    const { sealEnvelopeFor } = await import('../../src/crypto/envelope')
    const { utf8 } = await import('../../src/crypto/bytes')
    const bogus = await sealEnvelopeFor([{ keyId: 'sg_a:v1', key }], utf8('{"nope":true}'))
    await expect(openEvent(new Map([['sg_a:v1', key]]), bogus)).rejects.toThrow(EventFormatError)
  })
})
