import { describe, it, expect } from 'vitest'
import {
  NoRecipientError,
  UplinkFormatError,
  openAsRecipient,
  sealForRecipients,
  staffRecipients,
} from '../../src/inbox/uplink'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'
import type { RosterContents } from '../../src/crypto/roster'

async function rosterWith(): Promise<{
  roster: RosterContents
  admin: { userId: string; pair: Awaited<ReturnType<typeof generateEcdhKeyPair>> }
  staff: { userId: string; pair: Awaited<ReturnType<typeof generateEcdhKeyPair>> }
  member: { userId: string; pair: Awaited<ReturnType<typeof generateEcdhKeyPair>> }
}> {
  const admin = { userId: 'u_watanabe', pair: await generateEcdhKeyPair() }
  const staff = { userId: 'u_tanaka', pair: await generateEcdhKeyPair() }
  const member = { userId: 'u_sato', pair: await generateEcdhKeyPair() }
  const roster: RosterContents = {
    groupId: 'midori',
    generation: 1,
    subgroups: [],
    members: [
      {
        userId: admin.userId,
        displayName: '渡辺 けい',
        role: 'admin',
        scopes: ['all', 'staff'],
        ecdhPublic: toBase64(admin.pair.publicKey),
        ecdsaPublic: 'x',
      },
      {
        userId: staff.userId,
        displayName: '田中 みか',
        role: 'staff',
        scopes: ['all', 'staff'],
        ecdhPublic: toBase64(staff.pair.publicKey),
        ecdsaPublic: 'x',
      },
      {
        userId: member.userId,
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: ['all'],
        ecdhPublic: toBase64(member.pair.publicKey),
        ecdsaPublic: 'x',
      },
    ],
  }
  return { roster, admin, staff, member }
}

describe('staffRecipients', () => {
  it('picks admins and staff', async () => {
    const { roster } = await rosterWith()
    expect(staffRecipients(roster).map((r) => r.userId).sort()).toEqual([
      'u_tanaka',
      'u_watanabe',
    ])
  })

  it('never includes a member', async () => {
    const { roster } = await rosterWith()
    expect(staffRecipients(roster).map((r) => r.userId)).not.toContain('u_sato')
  })

  it('returns an empty list when the roster has no staff', async () => {
    const { roster } = await rosterWith()
    const membersOnly = { ...roster, members: roster.members.filter((m) => m.role === 'member') }
    expect(staffRecipients(membersOnly)).toEqual([])
  })
})

describe('sealForRecipients / openAsRecipient', () => {
  it('lets every addressed recipient open it', async () => {
    const { roster, admin, staff } = await rosterWith()
    const sealed = await sealForRecipients(staffRecipients(roster), utf8('体調不良のため欠席します'))
    expect(fromUtf8(await openAsRecipient(admin.userId, admin.pair.privateKey, sealed))).toBe(
      '体調不良のため欠席します',
    )
    expect(fromUtf8(await openAsRecipient(staff.userId, staff.pair.privateKey, sealed))).toBe(
      '体調不良のため欠席します',
    )
  })

  it('cannot be opened by someone who was not addressed', async () => {
    const { roster, member } = await rosterWith()
    const sealed = await sealForRecipients(staffRecipients(roster), utf8('secret'))
    await expect(
      openAsRecipient(member.userId, member.pair.privateKey, sealed),
    ).rejects.toThrow()
  })

  it('cannot be opened with the wrong private key even under the right user id', async () => {
    const { roster, admin } = await rosterWith()
    const stranger = await generateEcdhKeyPair()
    const sealed = await sealForRecipients(staffRecipients(roster), utf8('secret'))
    await expect(
      openAsRecipient(admin.userId, stranger.privateKey, sealed),
    ).rejects.toThrow()
  })

  it('does not leak the plaintext or the recipient public keys', async () => {
    const { roster } = await rosterWith()
    const sealed = await sealForRecipients(staffRecipients(roster), utf8('体調不良'))
    const raw = fromUtf8(sealed)
    expect(raw).not.toContain('体調不良')
    expect(raw).not.toContain(roster.members[0]?.ecdhPublic)
  })

  it('uses a fresh content key for every seal', async () => {
    const { roster } = await rosterWith()
    const a = await sealForRecipients(staffRecipients(roster), utf8('body'))
    const b = await sealForRecipients(staffRecipients(roster), utf8('body'))
    expect(fromUtf8(a)).not.toBe(fromUtf8(b))
  })

  it('refuses to seal with no recipients', async () => {
    await expect(sealForRecipients([], utf8('body'))).rejects.toThrow(NoRecipientError)
  })

  it('rejects bytes that are not an uplink packet', async () => {
    const { admin } = await rosterWith()
    await expect(
      openAsRecipient(admin.userId, admin.pair.privateKey, utf8('{"nope":true}')),
    ).rejects.toThrow(UplinkFormatError)
  })

  it('rejects a packet whose version is unknown', async () => {
    const { roster, admin } = await rosterWith()
    const sealed = await sealForRecipients(staffRecipients(roster), utf8('body'))
    const tampered = utf8(JSON.stringify({ ...JSON.parse(fromUtf8(sealed)), v: 99 }))
    await expect(
      openAsRecipient(admin.userId, admin.pair.privateKey, tampered),
    ).rejects.toThrow(UplinkFormatError)
  })
})
