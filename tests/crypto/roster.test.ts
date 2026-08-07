import { describe, it, expect } from 'vitest'
import {
  RosterVerificationError,
  ALL_SCOPE,
  STAFF_SCOPE,
  canonicalize,
  resolveScopes,
  signRoster,
  verifyRoster,
  serializeRosterFile,
  parseRosterFile,
} from '../../src/crypto/roster'
import type { RosterContents, Subgroup } from '../../src/crypto/roster'
import { generateEcdsaKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'

const subgroups: Subgroup[] = [
  { id: 'sg_a', name: 'Aチーム', parent: null },
  { id: 'sg_a_pickup', name: '送迎係', parent: 'sg_a' },
  { id: 'sg_b', name: 'Bチーム', parent: null },
]

const contents: RosterContents = {
  groupId: 'midori',
  generation: 1,
  subgroups,
  members: [
    {
      userId: 'u_b',
      displayName: '田中 みか',
      role: 'staff',
      scopes: ['all', 'staff', 'sg_a'],
      ecdhPublic: 'BBBB',
      ecdsaPublic: 'bbbb',
    },
    {
      userId: 'u_a',
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: ['all', 'sg_a'],
      ecdhPublic: 'AAAA',
      ecdsaPublic: 'aaaa',
    },
  ],
}

describe('resolveScopes', () => {
  it('always grants the all scope', () => {
    expect(resolveScopes(subgroups, 'member', [])).toEqual([ALL_SCOPE])
  })

  it('grants the staff scope to admins and staff only', () => {
    expect(resolveScopes(subgroups, 'admin', [])).toContain(STAFF_SCOPE)
    expect(resolveScopes(subgroups, 'staff', [])).toContain(STAFF_SCOPE)
    expect(resolveScopes(subgroups, 'member', [])).not.toContain(STAFF_SCOPE)
  })

  it('propagates membership up to every ancestor subgroup', () => {
    expect(resolveScopes(subgroups, 'member', ['sg_a_pickup'])).toEqual([
      ALL_SCOPE,
      'sg_a',
      'sg_a_pickup',
    ])
  })

  it('does not grant a child subgroup to a member of its parent', () => {
    expect(resolveScopes(subgroups, 'member', ['sg_a'])).not.toContain('sg_a_pickup')
  })

  it('deduplicates overlapping memberships', () => {
    expect(resolveScopes(subgroups, 'member', ['sg_a', 'sg_a_pickup'])).toEqual([
      ALL_SCOPE,
      'sg_a',
      'sg_a_pickup',
    ])
  })

  it('rejects an unknown subgroup', () => {
    expect(() => resolveScopes(subgroups, 'member', ['sg_zzz'])).toThrow(
      RosterVerificationError,
    )
  })

  it('rejects a cycle in the subgroup tree', () => {
    const cyclic: Subgroup[] = [
      { id: 'sg_x', name: 'X', parent: 'sg_y' },
      { id: 'sg_y', name: 'Y', parent: 'sg_x' },
    ]
    expect(() => resolveScopes(cyclic, 'member', ['sg_x'])).toThrow(RosterVerificationError)
  })
})

describe('roster', () => {
  it('canonicalizes members in a stable order regardless of input order', () => {
    const reversed: RosterContents = { ...contents, members: [...contents.members].reverse() }
    expect(fromUtf8(canonicalize(contents))).toBe(fromUtf8(canonicalize(reversed)))
    const text = fromUtf8(canonicalize(contents))
    expect(text.indexOf('u_a')).toBeLessThan(text.indexOf('u_b'))
  })

  it('canonicalizes subgroups in a stable order regardless of input order', () => {
    const reversed: RosterContents = {
      ...contents,
      subgroups: [...contents.subgroups].reverse(),
    }
    expect(fromUtf8(canonicalize(contents))).toBe(fromUtf8(canonicalize(reversed)))
  })

  it('rejects a roster whose subgroup tree was modified after signing', async () => {
    const admin = await generateEcdsaKeyPair()
    const file = await signRoster(contents, null, admin)
    const moved: RosterContents = {
      ...contents,
      subgroups: subgroups.map((subgroup) =>
        subgroup.id === 'sg_a_pickup' ? { ...subgroup, parent: 'sg_b' } : subgroup,
      ),
    }
    const forged = { ...file, contents: toBase64(canonicalize(moved)) }
    await expect(verifyRoster(forged, admin.publicKey)).rejects.toThrow(
      RosterVerificationError,
    )
  })

  it('verifies a roster signed by the trusted admin key', async () => {
    const admin = await generateEcdsaKeyPair()
    const file = await signRoster(contents, null, admin)
    const verified = await verifyRoster(file, admin.publicKey)
    expect(verified.groupId).toBe('midori')
    expect(verified.members).toHaveLength(2)
  })

  it('rejects a roster signed by a different key', async () => {
    const admin = await generateEcdsaKeyPair()
    const impostor = await generateEcdsaKeyPair()
    const file = await signRoster(contents, null, impostor)
    await expect(verifyRoster(file, admin.publicKey)).rejects.toThrow(RosterVerificationError)
  })

  it('rejects a roster whose contents were modified after signing', async () => {
    const admin = await generateEcdsaKeyPair()
    const file = await signRoster(contents, null, admin)
    const tampered: RosterContents = {
      ...contents,
      members: [
        ...contents.members,
        {
          userId: 'u_x',
          displayName: '侵入者',
          role: 'admin',
          scopes: ['all', 'staff'],
          ecdhPublic: 'XXXX',
          ecdsaPublic: 'xxxx',
        },
      ],
    }
    const forged = { ...file, contents: toBase64(canonicalize(tampered)) }
    await expect(verifyRoster(forged, admin.publicKey)).rejects.toThrow(
      RosterVerificationError,
    )
  })

  it('rejects a roster whose staff section was swapped', async () => {
    const admin = await generateEcdsaKeyPair()
    const file = await signRoster(contents, utf8('sealed-contacts'), admin)
    const forged = { ...file, staffSection: toBase64(utf8('other-contacts')) }
    await expect(verifyRoster(forged, admin.publicKey)).rejects.toThrow(
      RosterVerificationError,
    )
  })

  it('carries the staff section through a signature round trip', async () => {
    const admin = await generateEcdsaKeyPair()
    const file = await signRoster(contents, utf8('sealed-contacts'), admin)
    await expect(verifyRoster(file, admin.publicKey)).resolves.toBeDefined()
    expect(file.staffSection).toBe(toBase64(utf8('sealed-contacts')))
  })

  it('survives a serialize/parse round trip', async () => {
    const admin = await generateEcdsaKeyPair()
    const file = await signRoster(contents, null, admin)
    const reparsed = parseRosterFile(serializeRosterFile(file))
    await expect(verifyRoster(reparsed, admin.publicKey)).resolves.toBeDefined()
  })
})
