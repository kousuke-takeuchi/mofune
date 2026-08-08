import { describe, it, expect } from 'vitest'
import { resolveAudience } from '../../src/notify/recipients'
import type { ContactBook } from '../../src/group/contacts'
import type { NotificationSettings } from '../../src/group/group-settings'
import type { RosterContents } from '../../src/crypto/roster'

const roster: RosterContents = {
  groupId: 'midori',
  generation: 1,
  subgroups: [
    { id: 'sg_a', name: 'Aチーム', parent: null },
    { id: 'sg_b', name: 'Bチーム', parent: null },
  ],
  members: [
    {
      userId: 'u_tanaka',
      displayName: '田中 みか',
      role: 'staff',
      scopes: ['all', 'staff', 'sg_a'],
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
    {
      userId: 'u_sato',
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: ['all', 'sg_a'],
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
    {
      userId: 'u_mori',
      displayName: '森 ゆい',
      role: 'member',
      scopes: ['all', 'sg_b'],
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
    {
      userId: 'u_new',
      displayName: '新井 はじめ',
      role: 'member',
      scopes: ['all', 'sg_a'],
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
  ],
}

const contacts: ContactBook = {
  u_tanaka: { email: 'tanaka@example.com' },
  u_sato: { email: 'sakura@example.com' },
  u_mori: { email: 'yui@example.com' },
  // u_new はまだ登録していない
}

const settings: NotificationSettings = { mutedScopes: [], channels: ['mailto'], functionToken: '' }

describe('resolveAudience', () => {
  it('reaches everyone in the addressed scope', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['sg_a'] })
    expect(audience.reachable.map((r) => r.userId).sort()).toEqual(['u_sato', 'u_tanaka'])
  })

  it('carries the display name and the address', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['sg_a'] })
    const sato = audience.reachable.find((r) => r.userId === 'u_sato')
    expect(sato?.displayName).toBe('佐藤 さくら')
    expect(sato?.email).toBe('sakura@example.com')
  })

  it('does not reach someone outside the addressed scope', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['sg_a'] })
    expect(audience.reachable.map((r) => r.userId)).not.toContain('u_mori')
  })

  it('reports members with no address instead of dropping them silently', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['sg_a'] })
    expect(audience.missingEmail).toEqual(['u_new'])
    expect(audience.reachable.map((r) => r.userId)).not.toContain('u_new')
  })

  it('excludes the author', () => {
    const audience = resolveAudience({
      roster,
      contacts,
      settings,
      scopes: ['sg_a'],
      excludeUserId: 'u_tanaka',
    })
    expect(audience.reachable.map((r) => r.userId)).toEqual(['u_sato'])
  })

  it('does not report the author as missing an address', () => {
    const audience = resolveAudience({
      roster,
      contacts,
      settings,
      scopes: ['sg_a'],
      excludeUserId: 'u_new',
    })
    expect(audience.missingEmail).toEqual([])
  })

  it('drops a scope that is muted', () => {
    const muted: NotificationSettings = { mutedScopes: ['sg_a'], channels: ['mailto'], functionToken: '' }
    const audience = resolveAudience({ roster, contacts, settings: muted, scopes: ['sg_a'] })
    expect(audience.reachable).toEqual([])
    expect(audience.muted).toEqual(['sg_a'])
  })

  it('still reaches people through a scope that is not muted', () => {
    const muted: NotificationSettings = { mutedScopes: ['sg_a'], channels: ['mailto'], functionToken: '' }
    const audience = resolveAudience({
      roster,
      contacts,
      settings: muted,
      scopes: ['sg_a', 'sg_b'],
    })
    expect(audience.reachable.map((r) => r.userId)).toEqual(['u_mori'])
    expect(audience.muted).toEqual(['sg_a'])
  })

  it('does not repeat someone who is in two addressed scopes', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['all', 'sg_a'] })
    const ids = audience.reachable.map((r) => r.userId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reaches the whole group through the all scope', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['all'] })
    expect(audience.reachable.map((r) => r.userId).sort()).toEqual([
      'u_mori',
      'u_sato',
      'u_tanaka',
    ])
  })

  it('returns nothing for a scope nobody belongs to', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['sg_zzz'] })
    expect(audience).toEqual({ reachable: [], missingEmail: [], muted: [] })
  })

  it('treats an empty address as missing', () => {
    const audience = resolveAudience({
      roster,
      contacts: { ...contacts, u_new: { email: '   ' } },
      settings,
      scopes: ['sg_a'],
    })
    expect(audience.missingEmail).toEqual(['u_new'])
  })
})
