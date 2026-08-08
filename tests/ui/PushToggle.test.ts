// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import PushToggle from '../../src/ui/PushToggle.vue'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { encodeManifest } from '../../src/group/manifest'
import { manifestPath } from '../../src/storage/paths'
import { parsePushRegistration } from '../../src/notify/push'
import { openAsRecipient } from '../../src/inbox/uplink'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { toBase64 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'

let mounted: VueWrapper[] = []

async function fixture(options: { functionUrl?: string } = {}) {
  const staff = await generateEcdhKeyPair()
  const storage = new MemoryStorageProvider()
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

  const session = {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_sato',
    displayName: '佐藤 さくら',
    role: 'member',
    scopes: ['all', 'sg_a'],
    groupKeys: new Map(),
    generation: 1,
    roster: {
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
    },
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  } as unknown as Session

  return { session, storage, staff }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
  vi.unstubAllGlobals()
})

function healthy() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, vapidPublicKey: 'BPUB' })),
  )
}

async function mountToggle(
  options: { functionUrl?: string; subscribe?: () => Promise<{ endpoint: string }> } = {},
) {
  const { session, storage, staff } = await fixture(options)
  const wrapper = mount(PushToggle, {
    props: {
      session,
      storage,
      subscribe:
        options.subscribe ?? (async () => ({ endpoint: 'https://push.invalid/sato' })),
    },
  })
  mounted.push(wrapper)
  await vi.waitFor(
    () => {
      if (!wrapper.find('[data-test="push-ready"]').exists()) throw new Error('still loading')
    },
    { timeout: 2000, interval: 10 },
  )
  return { wrapper, storage, staff }
}

describe('PushToggle', () => {
  it('says nothing can be done when the group has no function', async () => {
    const { wrapper } = await mountToggle()
    expect(wrapper.get('[data-test="push-unavailable"]').text()).toContain('通知')
    expect(wrapper.find('[data-test="push-subscribe"]').exists()).toBe(false)
  })

  it('offers to subscribe when the function answers', async () => {
    healthy()
    const { wrapper } = await mountToggle({ functionUrl: 'https://push.invalid' })
    expect(wrapper.find('[data-test="push-subscribe"]').exists()).toBe(true)
  })

  it('posts the subscription into the inbox, sealed for the staff', async () => {
    healthy()
    const { wrapper, storage, staff } = await mountToggle({
      functionUrl: 'https://push.invalid',
    })

    await wrapper.get('[data-test="push-subscribe"]').trigger('click')
    await vi.waitFor(
      () => {
        if (!wrapper.find('[data-test="push-done"]').exists()) throw new Error('not sent yet')
      },
      { timeout: 2000, interval: 10 },
    )

    // 書ける端末では投函まで済む。残るのは inbox の実物のほう
    const db = openGroupDatabase('midori')
    expect(await db.outbox.toArray()).toHaveLength(0)
    const dropped = await storage.list('midori/inbox/')
    expect(dropped).toHaveLength(1)
    const registration = parsePushRegistration(
      await openAsRecipient('u_tanaka', staff.privateKey, await storage.get(dropped[0]!.path)),
    )
    expect(registration.userId).toBe('u_sato')
    expect(registration.subscription.endpoint).toBe('https://push.invalid/sato')
  })

  it('shows what the browser said when it refuses', async () => {
    healthy()
    const { wrapper } = await mountToggle({
      functionUrl: 'https://push.invalid',
      subscribe: async () => {
        throw new Error('通知が許可されていません')
      },
    })

    await wrapper.get('[data-test="push-subscribe"]').trigger('click')
    await vi.waitFor(
      () => {
        if (!wrapper.find('[data-test="push-error"]').exists()) throw new Error('no error yet')
      },
      { timeout: 2000, interval: 10 },
    )
    expect(wrapper.get('[data-test="push-error"]').text()).toContain('許可')
  })

  it('says so when the function is down, without offering a button that cannot work', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('failed to fetch')
      }),
    )
    const { wrapper } = await mountToggle({ functionUrl: 'https://push.invalid' })
    expect(wrapper.find('[data-test="push-subscribe"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="push-unavailable"]').text()).toContain('つながりません')
  })
})
