// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import NotifyView from '../../src/ui/NotifyView.vue'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { pendingBatches } from '../../src/notify/delivery-log'
import { writeGroupSettings, DEFAULT_GROUP_SETTINGS } from '../../src/group/group-settings'
import { sealContacts } from '../../src/group/contacts'
import type { ContactBook } from '../../src/group/contacts'
import { signRoster, serializeRosterFile } from '../../src/crypto/roster'
import { generateEcdsaKeyPair } from '../../src/crypto/asymmetric'
import { generateAesKey } from '../../src/crypto/symmetric'
import { rosterPath, manifestPath } from '../../src/storage/paths'
import { encodeManifest } from '../../src/group/manifest'
import { MemoryStorageProvider } from '../../src/storage/memory'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

async function fixture(
  options: { withAddresses?: boolean; functionUrl?: string; functionToken?: string } = {},
) {
  const staffKey = await generateAesKey()
  const admin = await generateEcdsaKeyPair()
  const roster: RosterContents = {
    groupId: 'midori',
    generation: 1,
    subgroups: [{ id: 'sg_a', name: 'Aチーム', parent: null }],
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
        userId: 'u_new',
        displayName: '新井 はじめ',
        role: 'member',
        scopes: ['all', 'sg_a'],
        ecdhPublic: 'x',
        ecdsaPublic: 'x',
      },
    ],
  }
  const contacts: ContactBook =
    options.withAddresses === false ? {} : { u_sato: { email: 'sakura@example.com' } }
  const storage = new MemoryStorageProvider()
  const staffSection = await sealContacts({ contacts, staffKey, generation: 1 })
  const file = await signRoster(roster, staffSection, admin)
  await storage.put(rosterPath('midori'), serializeRosterFile(file))
  await writeGroupSettings({
    storage,
    groupId: 'midori',
    settings: {
      ...DEFAULT_GROUP_SETTINGS,
      notifications: {
        ...DEFAULT_GROUP_SETTINGS.notifications,
        functionToken: options.functionToken ?? '',
      },
    },
    staffKey,
    generation: 1,
  })
  await storage.put(
    manifestPath('midori'),
    encodeManifest({
      v: 1,
      groupId: 'midori',
      groupName: 'みどり台グループ',
      keyringGeneration: 1,
      rosterGeneration: 1,
      functionUrl: options.functionUrl ?? null,
      notificationChannels: ['mailto'],
    }),
  )

  const session: Session = {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role: 'staff',
    scopes: ['all', 'staff', 'sg_a'],
    groupKeys: new Map([['staff:v1', staffKey]]),
    generation: 1,
    roster,
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }

  const db = openGroupDatabase('midori')
  await db.messages.put({
    id: 'm_1',
    scopes: ['sg_a'],
    author: 'u_tanaka',
    at: '2026-08-08T09:00:00.000Z',
    body: '来週の集まりについて',
    attachments: [],
  })
  return { session, storage }
}

let mounted: VueWrapper[] = []

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

async function mountNotify(
  options: { withAddresses?: boolean; functionUrl?: string; functionToken?: string } = {},
) {
  const { session, storage } = await fixture(options)
  const wrapper = mount(NotifyView, { props: { session, storage, messageId: 'm_1' } })
  mounted.push(wrapper)
  await vi.waitFor(() => {
    if (!wrapper.find('[data-test="ready"]').exists()) throw new Error('still loading')
  }, { timeout: 2000, interval: 10 })
  return wrapper
}

describe('NotifyView', () => {
  it('offers a batch link for the reachable recipients', async () => {
    const wrapper = await mountNotify()
    const links = wrapper.findAll('[data-test="batch-link"]')
    expect(links).toHaveLength(1)
    expect(links[0]?.attributes('href')?.startsWith('mailto:')).toBe(true)
  })

  it('puts the addresses in bcc', async () => {
    const wrapper = await mountNotify()
    const href = wrapper.find('[data-test="batch-link"]').attributes('href') ?? ''
    expect(href).toContain('bcc=')
    expect(href.slice(0, href.indexOf('?'))).not.toContain('sakura@example.com')
  })

  it('does not address the author', async () => {
    const wrapper = await mountNotify()
    const href = wrapper.find('[data-test="batch-link"]').attributes('href') ?? ''
    expect(href).not.toContain('tanaka')
  })

  it('reports how many members have no address', async () => {
    const wrapper = await mountNotify()
    expect(wrapper.find('[data-test="missing-email"]').text()).toContain('1')
  })

  it('says there is nobody to notify when no address is registered', async () => {
    const wrapper = await mountNotify({ withAddresses: false })
    expect(wrapper.find('[data-test="nobody"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="batch-link"]')).toHaveLength(0)
  })

  it('records the batches as unsent when it opens', async () => {
    await mountNotify()
    await vi.waitFor(async () => {
      if ((await pendingBatches(openGroupDatabase('midori'), 'm_1')).length === 0) {
        throw new Error('not recorded yet')
      }
    }, { timeout: 2000, interval: 10 })
  })

  it('clears a batch once the user says it was sent', async () => {
    const wrapper = await mountNotify()
    await wrapper.find('[data-test="mark-sent"]').trigger('click')
    await vi.waitFor(async () => {
      if ((await pendingBatches(openGroupDatabase('midori'), 'm_1')).length !== 0) {
        throw new Error('still pending')
      }
    }, { timeout: 2000, interval: 10 })
  })

  it('says that sending cannot be verified automatically', async () => {
    const wrapper = await mountNotify()
    expect(wrapper.text()).toContain('自動では確認できません')
  })

  it('emits close', async () => {
    const wrapper = await mountNotify()
    await wrapper.find('[data-test="close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})

describe('when the group has a notification function', () => {
  function acceptPush(notified: string[]) {
    const calls = vi.fn(async (url: string) =>
      String(url).endsWith('/health')
        ? Response.json({ ok: true, vapidPublicKey: 'BPUB' })
        : Response.json({ sent: notified.length, gone: 0, notified }),
    )
    vi.stubGlobal('fetch', calls)
    return calls
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('wakes the subscribers and says how many were reached', async () => {
    acceptPush(['u_sato'])
    const wrapper = await mountNotify({
      functionUrl: 'https://push.invalid',
      functionToken: 'secret',
    })
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="push-result"]').exists()) throw new Error('no result yet')
    }, { timeout: 2000, interval: 10 })
    expect(wrapper.get('[data-test="push-result"]').text()).toContain('1')
  })

  it('leaves out of the mail whoever the push reached', async () => {
    acceptPush(['u_sato'])
    const wrapper = await mountNotify({
      functionUrl: 'https://push.invalid',
      functionToken: 'secret',
    })
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="push-result"]').exists()) throw new Error('no result yet')
    }, { timeout: 2000, interval: 10 })
    // 佐藤さんは push で届いたので、メールの相手は誰も残らない
    expect(wrapper.find('[data-test="nobody"]').exists()).toBe(true)
  })

  it('falls back to mail when the function does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('failed to fetch')
      }),
    )
    const wrapper = await mountNotify({
      functionUrl: 'https://push.invalid',
      functionToken: 'secret',
    })
    expect(wrapper.findAll('[data-test="batch-link"]')).toHaveLength(1)
    expect(wrapper.get('[data-test="push-result"]').text()).toContain('届きません')
  })
})
