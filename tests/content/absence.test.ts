import type { Bytes } from '../../src/crypto/bytes'
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  ABSENCE_KINDS,
  AbsenceError,
  DEFAULT_REASONS,
  buildAbsenceReport,
  newAbsenceId,
  parseAbsenceReport,
  sendAbsenceReport,
} from '../../src/content/absence'
import type { InboxGrant } from '../../src/inbox/grants'
import { openAsRecipient } from '../../src/inbox/uplink'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { pending } from '../../src/sync/outbox'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

const now = new Date('2026-08-08T07:30:00.000Z')

const grant: InboxGrant = {
  v: 1,
  issuedAt: '2026-08-08T00:00:00.000Z',
  expiresAt: '2026-08-15T00:00:00.000Z',
  slots: [
    { key: 'midori/inbox/u_sato/a.enc', url: 'https://example.invalid/a?X-Amz-Signature=x' },
    { key: 'midori/inbox/u_sato/b.enc', url: 'https://example.invalid/b?X-Amz-Signature=x' },
  ],
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
    roster,
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
  return { session, staff }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('absence vocabulary', () => {
  it('offers exactly the three kinds the requirements name', () => {
    expect(ABSENCE_KINDS).toEqual(['absent', 'late', 'early'])
  })

  it('ships a starting set of common reasons', () => {
    expect(DEFAULT_REASONS.length).toBeGreaterThan(0)
    expect(DEFAULT_REASONS).toContain('体調不良')
  })
})

describe('newAbsenceId', () => {
  it('is a random hex id', () => {
    expect(newAbsenceId()).toMatch(/^ab_[0-9a-f]{32}$/)
  })
})

describe('buildAbsenceReport', () => {
  it('records the kind, date, reason and note', async () => {
    const { session } = await memberSession()
    const report = buildAbsenceReport({
      session,
      kind: 'absent',
      date: '2026-08-08',
      reason: '体調不良',
      note: '朝から熱があるため、本日はお休みします。',
      now,
    })
    expect(report.kind).toBe('absent')
    expect(report.date).toBe('2026-08-08')
    expect(report.reason).toBe('体調不良')
    expect(report.note).toBe('朝から熱があるため、本日はお休みします。')
    expect(report.author).toBe('u_sato')
    expect(report.at).toBe('2026-08-08T07:30:00.000Z')
  })

  it('rejects a date that is not YYYY-MM-DD', async () => {
    const { session } = await memberSession()
    expect(() =>
      buildAbsenceReport({ session, kind: 'absent', date: '8/8', reason: '', note: '', now }),
    ).toThrow(AbsenceError)
  })

  it('rejects an unknown kind', async () => {
    const { session } = await memberSession()
    expect(() =>
      buildAbsenceReport({
        session,
        kind: 'holiday' as never,
        date: '2026-08-08',
        reason: '',
        note: '',
        now,
      }),
    ).toThrow(AbsenceError)
  })

  it('allows an empty reason and note', async () => {
    const { session } = await memberSession()
    const report = buildAbsenceReport({
      session,
      kind: 'late',
      date: '2026-08-08',
      reason: '',
      note: '',
      now,
    })
    expect(report.reason).toBe('')
    expect(report.note).toBe('')
  })
})

describe('sendAbsenceReport', () => {
  it('queues a packet only staff can read', async () => {
    const { session, staff } = await memberSession()
    const db = openGroupDatabase('midori')
    const report = buildAbsenceReport({
      session,
      kind: 'absent',
      date: '2026-08-08',
      reason: '体調不良',
      note: '朝から熱があります',
      now,
    })
    await sendAbsenceReport({ session, db, grant, report, now })

    const queued = await pending(db)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.kind).toBe('inbox')
    const body = queued[0]?.body as Bytes
    expect(fromUtf8(body)).not.toContain('体調不良')

    const opened = parseAbsenceReport(
      await openAsRecipient('u_tanaka', staff.privateKey, body),
    )
    expect(opened.reason).toBe('体調不良')
    expect(opened.note).toBe('朝から熱があります')
    expect(opened.author).toBe('u_sato')
  })

  it('round-trips through parseAbsenceReport', async () => {
    const { session } = await memberSession()
    const report = buildAbsenceReport({
      session,
      kind: 'early',
      date: '2026-08-09',
      reason: '通院',
      note: '',
      now,
    })
    expect(parseAbsenceReport(utf8(JSON.stringify(report)))).toEqual(report)
  })

  it('rejects bytes that are not an absence report', () => {
    expect(() => parseAbsenceReport(utf8('{"nope":true}'))).toThrow(AbsenceError)
  })
})
