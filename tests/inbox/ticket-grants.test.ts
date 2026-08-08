import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { issueTicketGrant, publishGrants, readGrant, grantPath } from '../../src/inbox/grants'
import { submitToInbox } from '../../src/inbox/submit'
import { flushOutbox } from '../../src/sync/outbox'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { inboxTicket } from '../../src/storage/function'
import { toBase64, utf8, fromUtf8 } from '../../src/crypto/bytes'
import type { RosterContents } from '../../src/crypto/roster'
import type { Session } from '../../src/group/session'
import type { FunctionStorageSettings } from '../../src/group/storage-credentials'

const settings: FunctionStorageSettings = {
  provider: 'gdrive',
  functionUrl: 'https://script.google.com/macros/s/AK/exec',
  publicBaseUrl: 'https://script.google.com/macros/s/AK/exec',
  token: 'shared-secret',
}

async function world() {
  const staff = await generateEcdhKeyPair()
  const member = await generateEcdhKeyPair()
  const roster: RosterContents = {
    groupId: 'g_midori',
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
      {
        userId: 'u_sato',
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: ['all'],
        ecdhPublic: toBase64(member.publicKey),
        ecdsaPublic: 'x',
      },
    ],
  }
  const session = {
    groupId: 'g_midori',
    groupName: 'みどり台',
    userId: 'u_sato',
    displayName: '佐藤 さくら',
    role: 'member',
    scopes: ['all'],
    groupKeys: new Map(),
    generation: 1,
    roster,
    ecdhPrivate: member.privateKey,
    ecdsaPrivate: new Uint8Array(0),
  } as unknown as Session

  return { roster, session, member, storage: new MemoryStorageProvider() }
}

beforeEach(async () => {
  await deleteGroupDatabase('g_midori')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('issueTicketGrant', () => {
  it('hands out slots the function can check, without the secret itself', async () => {
    const { roster } = await world()
    const { grant } = await issueTicketGrant({
      groupId: 'g_midori',
      userId: 'u_sato',
      ecdhPublic: roster.members[1]?.ecdhPublic as string,
      settings,
    })

    expect(grant.slots.length).toBeGreaterThan(0)
    for (const slot of grant.slots) {
      if (slot.kind !== 'ticket') throw new Error('expected a ticket slot')
      expect(slot.key.startsWith('g_midori/inbox/u_sato/')).toBe(true)
      expect(slot.ticket).toBe(await inboxTicket(settings.token, slot.key))
      expect(slot.functionUrl).toBe(settings.functionUrl)
    }
    // 合言葉そのものは渡らない
    expect(JSON.stringify(grant)).not.toContain(settings.token)
  })

  it('gives each slot its own place, so one ticket cannot be reused elsewhere', async () => {
    const { roster } = await world()
    const { grant } = await issueTicketGrant({
      groupId: 'g_midori',
      userId: 'u_sato',
      ecdhPublic: roster.members[1]?.ecdhPublic as string,
      settings,
    })
    const keys = grant.slots.map((slot) => slot.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('publishGrants on a function-backed group', () => {
  it('gives every participant a set of tickets', async () => {
    const { roster, storage, member } = await world()

    const issued = await publishGrants({ storage, groupId: 'g_midori', roster, settings })

    expect(issued).toEqual(['u_sato'])
    const grant = await readGrant({
      storage,
      groupId: 'g_midori',
      userId: 'u_sato',
      ecdhPrivate: member.privateKey,
    })
    expect(grant.slots[0]?.kind).toBe('ticket')
  })

  it('leaves staff out, because they can write directly', async () => {
    const { roster, storage } = await world()
    const issued = await publishGrants({ storage, groupId: 'g_midori', roster, settings })
    expect(issued).not.toContain('u_tanaka')
    await expect(storage.get(grantPath('g_midori', 'u_tanaka'))).rejects.toThrow()
  })
})

describe('posting with a ticket', () => {
  it('goes to the function, not to a presigned url', async () => {
    const { roster, storage, session, member } = await world()
    await publishGrants({ storage, groupId: 'g_midori', roster, settings })
    const grant = await readGrant({
      storage,
      groupId: 'g_midori',
      userId: 'u_sato',
      ecdhPrivate: member.privateKey,
    })

    const calls = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal('fetch', calls)

    const db = openGroupDatabase('g_midori')
    await submitToInbox({ session, db, grant, plaintext: utf8('欠席します') })
    const flushed = await flushOutbox({ db, storage })

    expect(flushed.failed).toBe(0)
    expect(calls).toHaveBeenCalledTimes(1)
    const [url, init] = calls.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('path=%2Finbox')
    const body = JSON.parse(init.body as string) as Record<string, string>
    const first = grant.slots[0]
    if (first?.kind !== 'ticket') throw new Error('expected a ticket slot')
    expect(body.key).toBe(first.key)
    expect(body.ticket).toBe(first.ticket)
    expect(body.group_id).toBe('g_midori')
    // 中身は封緘済み。平文は通らない
    expect(fromUtf8(new Uint8Array(Buffer.from(body.body, 'base64')) as never)).not.toContain(
      '欠席します',
    )
  })

  it('keeps the item queued when the function refuses', async () => {
    const { roster, storage, session, member } = await world()
    await publishGrants({ storage, groupId: 'g_midori', roster, settings })
    const grant = await readGrant({
      storage,
      groupId: 'g_midori',
      userId: 'u_sato',
      ecdhPrivate: member.privateKey,
    })
    // Apps Script は断るときも 200 で error を返す
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unauthorized' })))

    const db = openGroupDatabase('g_midori')
    await submitToInbox({ session, db, grant, plaintext: utf8('欠席します') })
    const flushed = await flushOutbox({ db, storage })

    expect(flushed.failed).toBe(1)
    expect(await db.outbox.count()).toBe(1)
  })
})
