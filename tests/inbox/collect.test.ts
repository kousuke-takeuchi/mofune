import type { Bytes } from '../../src/crypto/bytes'
import { describe, it, expect } from 'vitest'
import { collectInbox, discardInboxItem } from '../../src/inbox/collect'
import { sealForRecipients } from '../../src/inbox/uplink'
import { grantPath } from '../../src/inbox/grants'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

async function fixture() {
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
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role: 'staff',
    scopes: ['all', 'staff'],
    groupKeys: new Map(),
    roster,
    ecdhPrivate: staff.privateKey,
    ecdsaPrivate: new Uint8Array(0),
  }
  return { session, staff, roster }
}

describe('collectInbox', () => {
  it('returns nothing when the inbox is empty', async () => {
    const { session } = await fixture()
    const result = await collectInbox({ storage: new MemoryStorageProvider(), session })
    expect(result).toEqual({ items: [], unreadable: 0 })
  })

  it('reads every packet addressed to this staff member', async () => {
    const { session, roster } = await fixture()
    const storage = new MemoryStorageProvider()
    const recipients = [
      { userId: 'u_tanaka', ecdhPublic: roster.members[0]?.ecdhPublic as string },
    ]
    await storage.put(
      'midori/inbox/u_sato/aaaa.enc',
      await sealForRecipients(recipients, utf8('体調不良のため欠席します')),
    )
    const result = await collectInbox({ storage, session })
    expect(result.items).toHaveLength(1)
    expect(fromUtf8(result.items[0]?.body as Bytes)).toBe('体調不良のため欠席します')
    expect(result.items[0]?.key).toBe('midori/inbox/u_sato/aaaa.enc')
  })

  it('collects across several members', async () => {
    const { session, roster } = await fixture()
    const storage = new MemoryStorageProvider()
    const recipients = [
      { userId: 'u_tanaka', ecdhPublic: roster.members[0]?.ecdhPublic as string },
    ]
    await storage.put('midori/inbox/u_sato/a.enc', await sealForRecipients(recipients, utf8('a')))
    await storage.put('midori/inbox/u_mori/b.enc', await sealForRecipients(recipients, utf8('b')))
    const result = await collectInbox({ storage, session })
    expect(result.items.map((item) => fromUtf8(item.body)).sort()).toEqual(['a', 'b'])
  })

  it('skips the grant object, which is not a submission', async () => {
    const { session, roster } = await fixture()
    const storage = new MemoryStorageProvider()
    const recipients = [
      { userId: 'u_tanaka', ecdhPublic: roster.members[0]?.ecdhPublic as string },
    ]
    await storage.put(grantPath('midori', 'u_sato'), await sealForRecipients(recipients, utf8('grant')))
    await storage.put('midori/inbox/u_sato/a.enc', await sealForRecipients(recipients, utf8('a')))
    const result = await collectInbox({ storage, session })
    expect(result.items).toHaveLength(1)
    expect(fromUtf8(result.items[0]?.body as Bytes)).toBe('a')
  })

  it('counts packets it cannot open instead of failing', async () => {
    const { session } = await fixture()
    const storage = new MemoryStorageProvider()
    const other = await generateEcdhKeyPair()
    await storage.put(
      'midori/inbox/u_sato/a.enc',
      await sealForRecipients(
        [{ userId: 'u_former', ecdhPublic: toBase64(other.publicKey) }],
        utf8('older submission'),
      ),
    )
    const result = await collectInbox({ storage, session })
    expect(result.items).toHaveLength(0)
    expect(result.unreadable).toBe(1)
  })

  it('counts garbage objects as unreadable rather than throwing', async () => {
    const { session } = await fixture()
    const storage = new MemoryStorageProvider()
    await storage.put('midori/inbox/u_sato/a.enc', utf8('not a packet'))
    const result = await collectInbox({ storage, session })
    expect(result.unreadable).toBe(1)
  })
})

describe('discardInboxItem', () => {
  it('removes a processed submission', async () => {
    const { session, roster } = await fixture()
    const storage = new MemoryStorageProvider()
    const recipients = [
      { userId: 'u_tanaka', ecdhPublic: roster.members[0]?.ecdhPublic as string },
    ]
    await storage.put('midori/inbox/u_sato/a.enc', await sealForRecipients(recipients, utf8('a')))
    await discardInboxItem({ storage, key: 'midori/inbox/u_sato/a.enc' })
    expect((await collectInbox({ storage, session })).items).toHaveLength(0)
  })
})
