import type { Bytes } from '../../src/crypto/bytes'
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { SubmitError, nextSlot, submitToInbox, usedSlots } from '../../src/inbox/submit'
import type { InboxGrant } from '../../src/inbox/grants'
import { openAsRecipient } from '../../src/inbox/uplink'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { pending } from '../../src/sync/outbox'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

const now = new Date('2026-08-08T09:00:00.000Z')

function grantWith(count: number, expiresAt = '2026-08-15T09:00:00.000Z'): InboxGrant {
  return {
    v: 1,
    issuedAt: '2026-08-08T09:00:00.000Z',
    expiresAt,
    slots: Array.from({ length: count }, (_, i) => ({
      key: `midori/inbox/u_sato/${String(i).padStart(32, '0')}.enc`,
      url: `https://example.invalid/mofune/midori/inbox/u_sato/${i}?X-Amz-Signature=deadbeef`,
    })),
  }
}

async function memberSession(): Promise<{ session: Session; staff: Awaited<ReturnType<typeof generateEcdhKeyPair>> }> {
  const staff = await generateEcdhKeyPair()
  const roster: RosterContents = {
    groupId: 'midori',
    generation: 1,
    subgroups: [],
    members: [
      {
        userId: 'u_tanaka',
        displayName: '田中 みか',
        role: 'staff',
        scopes: ['all', 'staff'],
        ecdhPublic: toBase64(staff.publicKey),
        ecdsaPublic: 'x',
      },
    ],
  }
  return {
    staff,
    session: {
      groupId: 'midori',
      groupName: 'みどり台グループ',
      userId: 'u_sato',
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: ['all'],
      groupKeys: new Map(),
      roster,
      ecdhPrivate: new Uint8Array(0),
      ecdsaPrivate: new Uint8Array(0),
    },
  }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('nextSlot', () => {
  it('returns the first unused slot', () => {
    const grant = grantWith(3)
    expect(nextSlot(grant, [], now).key).toBe(grant.slots[0]?.key)
  })

  it('skips slots that have already been used', () => {
    const grant = grantWith(3)
    const used = [grant.slots[0]?.key as string]
    expect(nextSlot(grant, used, now).key).toBe(grant.slots[1]?.key)
  })

  it('refuses when every slot has been used', () => {
    const grant = grantWith(2)
    const used = grant.slots.map((slot) => slot.key)
    expect(() => nextSlot(grant, used, now)).toThrow(SubmitError)
  })

  it('refuses when the grant has expired', () => {
    const grant = grantWith(3, '2026-08-01T00:00:00.000Z')
    expect(() => nextSlot(grant, [], now)).toThrow(SubmitError)
  })
})

describe('submitToInbox', () => {
  it('queues the sealed packet against an unused slot url', async () => {
    const { session } = await memberSession()
    const db = openGroupDatabase('midori')
    const grant = grantWith(3)
    const result = await submitToInbox({
      session,
      db,
      grant,
      plaintext: utf8('体調不良のため欠席します'),
      now,
    })
    const queued = await pending(db)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.kind).toBe('inbox')
    expect(queued[0]?.path).toBe(grant.slots[0]?.url)
    expect(result.key).toBe(grant.slots[0]?.key)
  })

  it('seals the packet so only staff can open it', async () => {
    const { session, staff } = await memberSession()
    const db = openGroupDatabase('midori')
    await submitToInbox({ session, db, grant: grantWith(1), plaintext: utf8('体調不良'), now })
    const body = (await pending(db))[0]?.body as Bytes
    expect(fromUtf8(body)).not.toContain('体調不良')
    expect(fromUtf8(await openAsRecipient('u_tanaka', staff.privateKey, body))).toBe('体調不良')
  })

  it('records the slot as used so it is never reused', async () => {
    const { session } = await memberSession()
    const db = openGroupDatabase('midori')
    const grant = grantWith(3)
    await submitToInbox({ session, db, grant, plaintext: utf8('one'), now })
    expect(await usedSlots(db)).toEqual([grant.slots[0]?.key])
    await submitToInbox({ session, db, grant, plaintext: utf8('two'), now })
    expect(await usedSlots(db)).toEqual([grant.slots[0]?.key, grant.slots[1]?.key])
  })

  it('never posts twice to the same url', async () => {
    const { session } = await memberSession()
    const db = openGroupDatabase('midori')
    const grant = grantWith(3)
    await submitToInbox({ session, db, grant, plaintext: utf8('one'), now })
    await submitToInbox({ session, db, grant, plaintext: utf8('two'), now })
    const paths = (await pending(db)).map((item) => item.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('refuses once the slots run out', async () => {
    const { session } = await memberSession()
    const db = openGroupDatabase('midori')
    const grant = grantWith(1)
    await submitToInbox({ session, db, grant, plaintext: utf8('one'), now })
    await expect(
      submitToInbox({ session, db, grant, plaintext: utf8('two'), now }),
    ).rejects.toThrow(SubmitError)
  })

  it('refuses when the roster has no staff to receive it', async () => {
    const { session } = await memberSession()
    const noStaff = { ...session, roster: { ...session.roster, members: [] } }
    const db = openGroupDatabase('midori')
    await expect(
      submitToInbox({ session: noStaff, db, grant: grantWith(1), plaintext: utf8('x'), now }),
    ).rejects.toThrow()
  })
})
