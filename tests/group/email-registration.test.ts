import type { Bytes } from '../../src/crypto/bytes'
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  EmailRegistrationError,
  buildEmailRegistration,
  isEmailConfirmed,
  isPlausibleEmail,
  markEmailConfirmed,
  parseEmailRegistration,
  sendEmailRegistration,
} from '../../src/group/email-registration'
import type { InboxGrant } from '../../src/inbox/grants'
import { openAsRecipient } from '../../src/inbox/uplink'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { pending } from '../../src/sync/outbox'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

const now = new Date('2026-08-08T09:00:00.000Z')

const grant: InboxGrant = {
  v: 1,
  issuedAt: '2026-08-08T00:00:00.000Z',
  expiresAt: '2026-08-15T00:00:00.000Z',
  slots: [{ key: 'midori/inbox/u_sato/a.enc', url: 'https://example.invalid/a?X-Amz-Signature=x' }],
}

async function memberSession() {
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
  const session: Session = {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_sato',
    displayName: '佐藤 さくら',
    role: 'member',
    scopes: ['all'],
    groupKeys: new Map(),
    generation: 1,
    roster,
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
  return { session, staff }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('isPlausibleEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isPlausibleEmail('sakura@example.com')).toBe(true)
    expect(isPlausibleEmail('sakura.h+mofune@example.co.jp')).toBe(true)
  })

  it('rejects text with no at sign or no dot in the domain', () => {
    expect(isPlausibleEmail('sakura')).toBe(false)
    expect(isPlausibleEmail('sakura@example')).toBe(false)
  })

  it('rejects whitespace and empty input', () => {
    expect(isPlausibleEmail('')).toBe(false)
    expect(isPlausibleEmail('a b@example.com')).toBe(false)
  })
})

describe('buildEmailRegistration', () => {
  it('records the address against the signed-in user', async () => {
    const { session } = await memberSession()
    const registration = buildEmailRegistration({
      session,
      email: 'sakura@example.com',
      now,
    })
    expect(registration.userId).toBe('u_sato')
    expect(registration.email).toBe('sakura@example.com')
    expect(registration.at).toBe('2026-08-08T09:00:00.000Z')
  })

  it('trims surrounding whitespace', async () => {
    const { session } = await memberSession()
    expect(
      buildEmailRegistration({ session, email: '  sakura@example.com  ', now }).email,
    ).toBe('sakura@example.com')
  })

  it('refuses an implausible address', async () => {
    const { session } = await memberSession()
    expect(() => buildEmailRegistration({ session, email: 'sakura', now })).toThrow(
      EmailRegistrationError,
    )
  })
})

describe('sendEmailRegistration', () => {
  it('queues a packet only staff can read', async () => {
    const { session, staff } = await memberSession()
    const db = openGroupDatabase('midori')
    const registration = buildEmailRegistration({ session, email: 'sakura@example.com', now })
    await sendEmailRegistration({ session, db, grant, registration, now })

    const queued = await pending(db)
    expect(queued).toHaveLength(1)
    const body = queued[0]?.body as Bytes
    // 連絡先は参加者どうしに見えてはならない(要件書 §5.3)
    expect(fromUtf8(body)).not.toContain('sakura@example.com')

    const opened = parseEmailRegistration(
      await openAsRecipient('u_tanaka', staff.privateKey, body),
    )
    expect(opened.email).toBe('sakura@example.com')
  })

  it('rejects bytes that are not a registration', () => {
    expect(() => parseEmailRegistration(utf8('{"nope":true}'))).toThrow(EmailRegistrationError)
  })
})

describe('confirmation flag', () => {
  it('starts unconfirmed', async () => {
    expect(await isEmailConfirmed(openGroupDatabase('midori'))).toBe(false)
  })

  it('is set once the user says the test notice arrived', async () => {
    const db = openGroupDatabase('midori')
    await markEmailConfirmed(db)
    expect(await isEmailConfirmed(db)).toBe(true)
  })

  it('survives reopening the database', async () => {
    await markEmailConfirmed(openGroupDatabase('midori'))
    expect(await isEmailConfirmed(openGroupDatabase('midori'))).toBe(true)
  })
})
