// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import StaffPanelView from '../../src/ui/StaffPanelView.vue'
import { sealForRecipients } from '../../src/inbox/uplink'
import { grantPath } from '../../src/inbox/grants'
import { writeStorageSettings } from '../../src/group/storage-credentials'
import { deleteGroupDatabase } from '../../src/db/group-db'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { toBase64, utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

const absence = {
  id: 'ab_1',
  kind: 'absent',
  date: '2026-08-08',
  reason: '体調不良',
  note: '',
  author: 'u_sato',
  at: '2026-08-08T07:30:00.000Z',
}

async function fixture(options: { withSettings?: boolean } = {}) {
  const staff = await generateEcdhKeyPair()
  const member = await generateEcdhKeyPair()
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
  const storage = new MemoryStorageProvider()
  if (options.withSettings !== false) {
    await writeStorageSettings({
      storage,
      groupId: 'midori',
      settings: {
        provider: 's3',
        endpoint: 'https://example.invalid',
        region: 'auto',
        bucket: 'mofune',
        publicBaseUrl: 'https://pub-1234.r2.dev',
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      },
      staffKey,
      generation: 1,
    })
  }
  return { session, storage, staff, staffKey }
}

let mounted: VueWrapper[] = []

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

async function mountPanel(session: Session, storage: MemoryStorageProvider) {
  const wrapper = mount(StaffPanelView, {
    props: { session, storage, adminPublicKey: new Uint8Array(0) },
  })
  mounted.push(wrapper)
  await vi.waitFor(() => {
    if (
      !wrapper.find('[data-test="ready"]').exists() &&
      !wrapper.find('[data-test="no-credentials"]').exists()
    ) {
      throw new Error('still loading')
    }
  }, { timeout: 2000, interval: 10 })
  return wrapper
}

describe('StaffPanelView', () => {
  it('says so when the storage credentials cannot be read', async () => {
    const { session, storage } = await fixture({ withSettings: false })
    const wrapper = await mountPanel(session, storage)
    expect(wrapper.find('[data-test="no-credentials"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="publish-grants"]').exists()).toBe(false)
  })

  it('publishes upload grants for every member', async () => {
    const { session, storage } = await fixture()
    const wrapper = await mountPanel(session, storage)
    await wrapper.find('[data-test="publish-grants"]').trigger('click')
    await vi.waitFor(async () => {
      if ((await storage.list(grantPath('midori', 'u_sato'))).length === 0) {
        throw new Error('not published yet')
      }
    }, { timeout: 2000, interval: 10 })
    expect(wrapper.find('[data-test="grants-issued"]').text()).toContain('1')
  })

  it('applies an absence submission and reports the count', async () => {
    const { session, storage, staff } = await fixture()
    await storage.put(
      'midori/inbox/u_sato/a.enc',
      await sealForRecipients(
        [{ userId: 'u_tanaka', ecdhPublic: toBase64(staff.publicKey) }],
        utf8(JSON.stringify(absence)),
      ),
    )
    const wrapper = await mountPanel(session, storage)
    await wrapper.find('[data-test="process-inbox"]').trigger('click')
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="applied-absences"]').exists()) {
        throw new Error('not applied yet')
      }
    }, { timeout: 2000, interval: 10 })
    expect(wrapper.find('[data-test="applied-absences"]').text()).toContain('1')
    expect(await storage.list('midori/events/')).toHaveLength(1)
  })

  it('tells a staff member that pending contact updates need an admin', async () => {
    const { session, storage, staff } = await fixture()
    await storage.put(
      'midori/inbox/u_sato/b.enc',
      await sealForRecipients(
        [{ userId: 'u_tanaka', ecdhPublic: toBase64(staff.publicKey) }],
        utf8(JSON.stringify({ v: 1, userId: 'u_sato', email: 'sakura@example.com', at: '2026-08-08T00:00:00.000Z' })),
      ),
    )
    const wrapper = await mountPanel(session, storage)
    await wrapper.find('[data-test="process-inbox"]').trigger('click')
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="needs-admin"]').exists()) throw new Error('not yet')
    }, { timeout: 2000, interval: 10 })
    expect(wrapper.find('[data-test="needs-admin"]').exists()).toBe(true)
  })

  it('reports an error instead of crashing when processing fails', async () => {
    const { session } = await fixture()
    const broken = {
      capabilities: { read: true, write: true, list: true, inbox: true },
      get: () => Promise.reject(new Error('offline')),
      put: () => Promise.reject(new Error('offline')),
      delete: () => Promise.reject(new Error('offline')),
      list: () => Promise.reject(new Error('offline')),
    } as unknown as MemoryStorageProvider
    const wrapper = await mountPanel(session, broken)
    expect(wrapper.find('[data-test="no-credentials"]').exists()).toBe(true)
  })

  it('emits close', async () => {
    const { session, storage } = await fixture()
    const wrapper = await mountPanel(session, storage)
    await wrapper.find('[data-test="close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
