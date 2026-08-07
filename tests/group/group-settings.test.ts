import { describe, it, expect } from 'vitest'
import {
  DEFAULT_GROUP_SETTINGS,
  GroupSettingsError,
  groupSettingsPath,
  readGroupSettings,
  renderTemplate,
  writeGroupSettings,
} from '../../src/group/group-settings'
import type { GroupSettings } from '../../src/group/group-settings'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { utf8 } from '../../src/crypto/bytes'

const custom: GroupSettings = {
  v: 1,
  mailTemplate: {
    subject: '{{グループ名}}に新しいお知らせがあります',
    body: '{{グループ名}}からのお知らせです。\n{{リンク}}',
  },
  absenceReasons: ['体調不良', '通院'],
  notifications: { mutedScopes: ['sg_b'], channels: ['mailto'] },
}

describe('groupSettingsPath', () => {
  it('points at the encrypted settings object', () => {
    expect(groupSettingsPath('midori')).toBe('midori/settings/templates.enc')
  })
})

describe('DEFAULT_GROUP_SETTINGS', () => {
  it('has a subject and a body', () => {
    expect(DEFAULT_GROUP_SETTINGS.mailTemplate.subject.length).toBeGreaterThan(0)
    expect(DEFAULT_GROUP_SETTINGS.mailTemplate.body.length).toBeGreaterThan(0)
  })

  it('mutes nothing by default', () => {
    expect(DEFAULT_GROUP_SETTINGS.notifications.mutedScopes).toEqual([])
  })

  it('ships the common absence reasons', () => {
    expect(DEFAULT_GROUP_SETTINGS.absenceReasons).toContain('体調不良')
  })
})

describe('renderTemplate', () => {
  it('substitutes the allowed placeholders', () => {
    expect(
      renderTemplate('{{グループ名}}: {{種別}} {{リンク}}', {
        グループ名: 'みどり台グループ',
        種別: 'お知らせ',
        リンク: 'https://mofune.site/app/',
      }),
    ).toBe('みどり台グループ: お知らせ https://mofune.site/app/')
  })

  it('substitutes every occurrence', () => {
    expect(renderTemplate('{{リンク}} {{リンク}}', { リンク: 'x' })).toBe('x x')
  })

  it('leaves an unknown placeholder visible rather than guessing', () => {
    expect(renderTemplate('{{本文}}', { グループ名: 'g' })).toBe('{{本文}}')
  })

  it('does not touch text without placeholders', () => {
    expect(renderTemplate('新着があります', { グループ名: 'g' })).toBe('新着があります')
  })
})

describe('readGroupSettings / writeGroupSettings', () => {
  it('round-trips the settings', async () => {
    const storage = new MemoryStorageProvider()
    const staffKey = await generateAesKey()
    await writeGroupSettings({ storage, groupId: 'midori', settings: custom, staffKey, generation: 1 })
    expect(await readGroupSettings({ storage, groupId: 'midori', staffKey })).toEqual(custom)
  })

  it('falls back to the defaults when nothing has been written', async () => {
    const storage = new MemoryStorageProvider()
    const staffKey = await generateAesKey()
    expect(await readGroupSettings({ storage, groupId: 'midori', staffKey })).toEqual(
      DEFAULT_GROUP_SETTINGS,
    )
  })

  it('does not leave the template in plaintext on storage', async () => {
    const storage = new MemoryStorageProvider()
    const staffKey = await generateAesKey()
    await writeGroupSettings({ storage, groupId: 'midori', settings: custom, staffKey, generation: 1 })
    const raw = new TextDecoder().decode(await storage.get(groupSettingsPath('midori')))
    expect(raw).not.toContain('新しいお知らせ')
    expect(raw).not.toContain('sg_b')
  })

  it('cannot be read by someone without the staff key', async () => {
    const storage = new MemoryStorageProvider()
    await writeGroupSettings({
      storage,
      groupId: 'midori',
      settings: custom,
      staffKey: await generateAesKey(),
      generation: 1,
    })
    await expect(
      readGroupSettings({ storage, groupId: 'midori', staffKey: await generateAesKey() }),
    ).rejects.toThrow(GroupSettingsError)
  })

  it('reports settings that are not a settings object', async () => {
    const storage = new MemoryStorageProvider()
    const staffKey = await generateAesKey()
    const { sealEnvelope } = await import('../../src/crypto/envelope')
    await storage.put(
      groupSettingsPath('midori'),
      await sealEnvelope(staffKey, 'staff:v1', utf8('"nope"')),
    )
    await expect(readGroupSettings({ storage, groupId: 'midori', staffKey })).rejects.toThrow(
      GroupSettingsError,
    )
  })

  it('replaces the previous settings rather than accumulating', async () => {
    const storage = new MemoryStorageProvider()
    const staffKey = await generateAesKey()
    await writeGroupSettings({ storage, groupId: 'midori', settings: custom, staffKey, generation: 1 })
    await writeGroupSettings({
      storage,
      groupId: 'midori',
      settings: { ...custom, absenceReasons: ['家庭の都合'] },
      staffKey,
      generation: 1,
    })
    expect((await readGroupSettings({ storage, groupId: 'midori', staffKey })).absenceReasons).toEqual([
      '家庭の都合',
    ])
    expect(await storage.list('midori/settings/')).toHaveLength(1)
  })
})
