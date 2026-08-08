// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import SetupView from '../../src/ui/SetupView.vue'
import { issueGrant, grantPath } from '../../src/inbox/grants'
import { isEmailConfirmed } from '../../src/group/email-registration'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { pending } from '../../src/sync/outbox'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { toBase64 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { StorageSettings } from '../../src/group/storage-credentials'
import type { RosterContents } from '../../src/crypto/roster'

const settings: StorageSettings = {
  provider: 's3',
  endpoint: 'https://example.invalid',
  region: 'auto',
  bucket: 'mofune',
  publicBaseUrl: 'https://pub-1234.r2.dev',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
}

async function fixture() {
  const member = await generateEcdhKeyPair()
  const staff = await generateEcdhKeyPair()
  const roster: RosterContents = {
    groupId: 'midori',
    generation: 1,
    subgroups: [],
    members: [
      {
        userId: 'u_sato',
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: ['all'],
        ecdhPublic: toBase64(member.publicKey),
        ecdsaPublic: 'x',
      },
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
    userId: 'u_sato',
    displayName: '佐藤 さくら',
    role: 'member',
    scopes: ['all'],
    groupKeys: new Map(),
    generation: 1,
    roster,
    ecdhPrivate: member.privateKey,
    ecdsaPrivate: new Uint8Array(0),
  }
  const storage = new MemoryStorageProvider()
  const { sealed } = await issueGrant({
    groupId: 'midori',
    userId: 'u_sato',
    ecdhPublic: toBase64(member.publicKey),
    settings,
  })
  await storage.put(grantPath('midori', 'u_sato'), sealed)
  return { session, storage }
}

let mounted: VueWrapper[] = []

/**
 * 投函先は presigned URL で、送信はプロバイダを通らず素の PUT で出る。
 * stub しないと実際に名前解決へ行き、走らせるたび結果が変わる。
 */
function acceptUploads(): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
}

beforeEach(async () => {
  acceptUploads()
  await deleteGroupDatabase('midori')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

async function mountSetup() {
  const { session, storage } = await fixture()
  const wrapper = mount(SetupView, { props: { session, storage } })
  mounted.push(wrapper)
  // grant の読み込みが終わって登録ボタンが押せるようになるまで待つ
  await vi.waitFor(() => {
    const button = wrapper.find('[data-test="register"]')
    if (!button.exists() || button.attributes('disabled') !== undefined) {
      throw new Error('still loading')
    }
  }, { timeout: 2000, interval: 10 })
  return wrapper
}

describe('SetupView', () => {
  it('explains that the address is needed for notifications', async () => {
    expect((await mountSetup()).text()).toContain('メールアドレス')
  })

  it('refuses an implausible address without sending anything', async () => {
    const wrapper = await mountSetup()
    await wrapper.find('[data-test="email"]').setValue('sakura')
    await wrapper.find('[data-test="register"]').trigger('click')
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="error"]').exists()) throw new Error('no error yet')
    }, { timeout: 2000, interval: 10 })
    expect(await pending(openGroupDatabase('midori'))).toHaveLength(0)
  })

  it('queues the registration through the inbox', async () => {
    const wrapper = await mountSetup()
    await wrapper.find('[data-test="email"]').setValue('sakura@example.com')
    await wrapper.find('[data-test="register"]').trigger('click')
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="confirm"]').exists()) throw new Error('not registered yet')
    }, { timeout: 2000, interval: 10 })
    expect(wrapper.find('[data-test="confirm"]').exists()).toBe(true)
  })

  it('does not offer the confirmation button before an address is registered', async () => {
    const wrapper = await mountSetup()
    expect(wrapper.find('[data-test="confirm"]').exists()).toBe(false)
  })

  it('unlocks only after the user says the test notice arrived', async () => {
    const wrapper = await mountSetup()
    await wrapper.find('[data-test="email"]').setValue('sakura@example.com')
    await wrapper.find('[data-test="register"]').trigger('click')
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="confirm"]').exists()) throw new Error('not registered yet')
    }, { timeout: 2000, interval: 10 })

    expect(await isEmailConfirmed(openGroupDatabase('midori'))).toBe(false)
    expect(wrapper.emitted('done')).toBeFalsy()

    await wrapper.find('[data-test="confirm"]').trigger('click')
    await vi.waitFor(() => {
      if (!wrapper.emitted('done')) throw new Error('not done yet')
    }, { timeout: 2000, interval: 10 })
    expect(await isEmailConfirmed(openGroupDatabase('midori'))).toBe(true)
  })

  it('says the address is not shown to other members', async () => {
    expect((await mountSetup()).text()).toContain('担当者')
  })
})
