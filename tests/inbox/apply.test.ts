import { describe, it, expect } from 'vitest'
import { applyInbox, classifySubmission } from '../../src/inbox/apply'
import { sealForRecipients } from '../../src/inbox/uplink'
import { grantPath } from '../../src/inbox/grants'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { toBase64, utf8 } from '../../src/crypto/bytes'
import { openEvent } from '../../src/sync/events'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

const now = new Date('2026-08-08T09:00:00.000Z')

const absence = {
  id: 'ab_1',
  kind: 'absent',
  date: '2026-08-08',
  reason: '体調不良',
  note: '朝から熱があります',
  author: 'u_sato',
  at: '2026-08-08T07:30:00.000Z',
}
const registration = {
  v: 1,
  userId: 'u_sato',
  email: 'sakura@example.com',
  at: '2026-08-08T07:35:00.000Z',
}

async function fixture() {
  const staff = await generateEcdhKeyPair()
  const staffKey = await generateAesKey()
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
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role: 'staff',
    scopes: ['all', 'staff'],
    groupKeys: new Map([['staff:v1', staffKey]]),
    generation: 1,
    roster,
    ecdhPrivate: staff.privateKey,
    ecdsaPrivate: new Uint8Array(0),
  }
  const recipients = [{ userId: 'u_tanaka', ecdhPublic: toBase64(staff.publicKey) }]
  const storage = new MemoryStorageProvider()
  const drop = async (key: string, payload: unknown) => {
    await storage.put(key, await sealForRecipients(recipients, utf8(JSON.stringify(payload))))
  }
  return { session, storage, staffKey, drop, recipients }
}

describe('classifySubmission', () => {
  it('recognises an absence report', () => {
    expect(classifySubmission(utf8(JSON.stringify(absence)))).toBe('absence')
  })

  it('recognises an email registration', () => {
    expect(classifySubmission(utf8(JSON.stringify(registration)))).toBe('email')
  })

  it('reports anything else as unknown', () => {
    expect(classifySubmission(utf8('{"hello":"world"}'))).toBe('unknown')
    expect(classifySubmission(utf8('not json'))).toBe('unknown')
  })
})

describe('applyInbox', () => {
  it('does nothing on an empty inbox', async () => {
    const { session, storage } = await fixture()
    const result = await applyInbox({ storage, session, now })
    expect(result).toMatchObject({
      absences: 0,
      emails: 0,
      unknown: 0,
      unreadable: 0,
      pendingContactUpdates: [],
      pushSubscriptions: 0,
      pendingPushRegistrations: [],
    })
  })

  it('writes an absence report onto the event log', async () => {
    const { session, storage, staffKey, drop } = await fixture()
    await drop('midori/inbox/u_sato/a.enc', absence)
    const result = await applyInbox({ storage, session, now })
    expect(result.absences).toBe(1)

    const events = await storage.list('midori/events/')
    expect(events).toHaveLength(1)
    const event = await openEvent(
      new Map([['staff:v1', staffKey]]),
      await storage.get(events[0]?.path as string),
    )
    expect(event.type).toBe('ABSENCE_REPORTED')
    expect((event.payload['absence'] as typeof absence).reason).toBe('体調不良')
  })

  it('addresses the absence event to the staff scope only', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/a.enc', absence)
    await applyInbox({ storage, session, now })
    const { readKeyIds } = await import('../../src/crypto/envelope')
    const events = await storage.list('midori/events/')
    expect(readKeyIds(await storage.get(events[0]?.path as string))).toEqual(['staff:v1'])
  })

  it('removes an applied absence from the inbox', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/a.enc', absence)
    await applyInbox({ storage, session, now })
    expect(await storage.list('midori/inbox/u_sato/')).toHaveLength(0)
  })

  it('returns email registrations without touching the roster', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/b.enc', registration)
    const result = await applyInbox({ storage, session, now })
    expect(result.emails).toBe(1)
    expect(result.pendingContactUpdates).toEqual([
      { userId: 'u_sato', email: 'sakura@example.com' },
    ])
    // 名簿の再署名は管理者だけができる。担当者は書き換えない。
    expect(await storage.list('midori/roster.sig.json')).toHaveLength(0)
  })

  it('removes an applied registration from the inbox', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/b.enc', registration)
    await applyInbox({ storage, session, now })
    expect(await storage.list('midori/inbox/u_sato/')).toHaveLength(0)
  })

  it('keeps an unrecognised submission instead of deleting it', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/c.enc', { hello: 'world' })
    const result = await applyInbox({ storage, session, now })
    expect(result.unknown).toBe(1)
    expect(await storage.list('midori/inbox/u_sato/')).toHaveLength(1)
  })

  it('counts packets it cannot open and leaves them alone', async () => {
    const { session, storage } = await fixture()
    const other = await generateEcdhKeyPair()
    await storage.put(
      'midori/inbox/u_sato/d.enc',
      await sealForRecipients(
        [{ userId: 'u_former', ecdhPublic: toBase64(other.publicKey) }],
        utf8(JSON.stringify(absence)),
      ),
    )
    const result = await applyInbox({ storage, session, now })
    expect(result.unreadable).toBe(1)
    expect(await storage.list('midori/inbox/u_sato/')).toHaveLength(1)
  })

  it('ignores the grant object', async () => {
    const { session, storage, drop } = await fixture()
    await drop(grantPath('midori', 'u_sato'), { v: 1, slots: [] })
    const result = await applyInbox({ storage, session, now })
    expect(result).toMatchObject({
      absences: 0,
      emails: 0,
      unknown: 0,
      unreadable: 0,
      pendingContactUpdates: [],
      pushSubscriptions: 0,
      pendingPushRegistrations: [],
    })
    expect(await storage.get(grantPath('midori', 'u_sato'))).toBeDefined()
  })

  it('handles a mixed inbox in one pass', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/a.enc', absence)
    await drop('midori/inbox/u_sato/b.enc', registration)
    await drop('midori/inbox/u_mori/c.enc', { hello: 'world' })
    const result = await applyInbox({ storage, session, now })
    expect(result.absences).toBe(1)
    expect(result.emails).toBe(1)
    expect(result.unknown).toBe(1)
  })

  it('refuses when the caller is a member', async () => {
    const { session, storage } = await fixture()
    const asMember = { ...session, role: 'member' as const }
    await expect(applyInbox({ storage, session: asMember, now })).rejects.toThrow()
  })
})

const pushRegistration = {
  v: 1,
  kind: 'push-subscription',
  userId: 'u_sato',
  scopes: ['all', 'sg_a'],
  subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' },
  at: '2026-08-08T07:40:00.000Z',
}

describe('push subscriptions arriving through the inbox', () => {
  it('is recognised as its own kind', () => {
    expect(classifySubmission(utf8(JSON.stringify(pushRegistration)))).toBe('push')
  })

  it('is collected for the admin to hand to the function', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/p.enc', pushRegistration)

    const result = await applyInbox({ storage, session, now })

    expect(result.pushSubscriptions).toBe(1)
    expect(result.pendingPushRegistrations).toEqual([pushRegistration])
    // 関数へ渡すまでは投函物を消さない。消してから渡せなかったら二度と戻せない
    expect((await storage.list('midori/inbox/')).map((entry) => entry.path)).toContain(
      'midori/inbox/u_sato/p.enc',
    )
  })

  it('is dropped once the registry has been handed over', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/p.enc', pushRegistration)

    const result = await applyInbox({ storage, session, now })
    await result.discardPush()

    expect(await storage.list('midori/inbox/')).toEqual([])
  })
})

const passwordChange = {
  v: 1,
  kind: 'password-change',
  userId: 'u_sato',
  email: 'sakura@example.com',
  keystore: '{"v":1,"kdf":{},"envelope":"AAAA"}',
  at: '2026-08-08T07:45:00.000Z',
}

describe('a password the participant chose for themselves', () => {
  it('is recognised as its own kind', () => {
    expect(classifySubmission(utf8(JSON.stringify(passwordChange)))).toBe('password')
  })

  it('is written where the login will look, and then the drop is cleared', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/pw.enc', passwordChange)

    const result = await applyInbox({ storage, session, now })

    expect(result.passwordsChanged).toBe(1)
    expect(await storage.list('midori/inbox/')).toEqual([])
    // キーストアの置き場所はアドレスから決まる。中身がそのまま入る
    const { keystorePath } = await import('../../src/storage/paths')
    const stored = await storage.get(await keystorePath('midori', 'sakura@example.com'))
    expect(new TextDecoder().decode(stored)).toBe(passwordChange.keystore)
  })

  it('is refused when it claims to be another member', async () => {
    const { session, storage, drop } = await fixture()
    // 森さんの受信箱に、佐藤さんを名乗る変更が置かれた
    await drop('midori/inbox/u_mori/pw.enc', passwordChange)

    const result = await applyInbox({ storage, session, now })

    expect(result.passwordsChanged).toBe(0)
    // 消さずに残す。担当者が気づけるように
    expect(await storage.list('midori/inbox/')).toHaveLength(1)
  })
})
