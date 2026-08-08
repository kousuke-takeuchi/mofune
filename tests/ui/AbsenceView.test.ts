// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import AbsenceView from '../../src/ui/AbsenceView.vue'
import { issueGrant, grantPath } from '../../src/inbox/grants'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { pending } from '../../src/sync/outbox'
import { HttpStorageProvider } from '../../src/storage/http'
import type { StorageProvider } from '../../src/storage/provider'
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
    roster,
    ecdhPrivate: member.privateKey,
    ecdsaPrivate: new Uint8Array(0),
  }
  return { session, member }
}

async function storageWithGrant(member: { publicKey: Uint8Array }) {
  const storage = new MemoryStorageProvider()
  const { sealed } = await issueGrant({
    groupId: 'midori',
    userId: 'u_sato',
    ecdhPublic: toBase64(member.publicKey as never),
    settings,
  })
  await storage.put(grantPath('midori', 'u_sato'), sealed)
  return storage
}

let mounted: VueWrapper[] = []

beforeEach(async () => {
  // 既定では投函を受け付ける。失敗を見たいテストだけ個別に上書きする。
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
  await deleteGroupDatabase('midori')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

async function mountAbsence(storage: StorageProvider, session: Session) {
  const wrapper = mount(AbsenceView, { props: { session, storage } })
  mounted.push(wrapper)
  await vi.waitFor(() => {
    if (!wrapper.find('[data-test="ready"]').exists() && !wrapper.find('[data-test="no-slots"]').exists()) {
      throw new Error('still loading')
    }
  }, { timeout: 2000, interval: 10 })
  return wrapper
}

/**
 * 投函先は presigned URL なので、送信はプロバイダを通らず素の PUT で出ていく。
 * ここを Memory プロバイダに吸わせてしまうと、本番だけ落ちる経路を見逃す。
 */
function acceptUploads(): ReturnType<typeof vi.fn> {
  const put = vi.fn(async () => new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', put)
  return put
}

describe('AbsenceView', () => {
  it('offers the three kinds from the requirements', async () => {
    const { session, member } = await fixture()
    const wrapper = await mountAbsence(await storageWithGrant(member), session)
    const kinds = wrapper.findAll('[data-test="kind"]').map((el) => el.attributes('data-kind'))
    expect(kinds).toEqual(['absent', 'late', 'early'])
  })

  it('offers the default reasons', async () => {
    const { session, member } = await fixture()
    const wrapper = await mountAbsence(await storageWithGrant(member), session)
    expect(wrapper.findAll('[data-test="reason"]').length).toBeGreaterThan(0)
    expect(wrapper.text()).toContain('体調不良')
  })

  it('sends a report through the inbox', async () => {
    const { session, member } = await fixture()
    const storage = await storageWithGrant(member)
    const wrapper = await mountAbsence(storage, session)
    const uploads = acceptUploads()
    await wrapper.find('[data-test="kind"][data-kind="absent"]').trigger('click')
    await wrapper.find('[data-test="note"]').setValue('朝から熱があります')
    await wrapper.find('[data-test="submit"]').trigger('click')
    // 待つべきは「送信が完了して sent が出ること」。キューに積まれた時点で
    // 待機を抜けると、送信前に検証してしまう。
    await vi.waitFor(() => {
      if (!wrapper.emitted('sent')) throw new Error('not sent yet')
    }, { timeout: 2000, interval: 10 })
    expect(wrapper.emitted('sent')).toBeTruthy()
    expect(await pending(openGroupDatabase('midori'))).toHaveLength(0)
    // 投函は presigned URL への PUT で出る
    expect(uploads).toHaveBeenCalledTimes(1)
  })

  it('tells a participant when no slots are available', async () => {
    const { session } = await fixture()
    // 参加者が持つのは公開読み専用の経路。枠が無ければ投函する手立てが無い。
    const wrapper = await mountAbsence(new HttpStorageProvider('https://public.invalid'), session)
    expect(wrapper.find('[data-test="no-slots"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="submit"]').exists()).toBe(false)
  })

  it('lets staff report without waiting for a slot', async () => {
    // 担当者は書き込み資格情報を持つので、枠が無くても自分で投函できる
    const { session } = await fixture()
    const wrapper = await mountAbsence(new MemoryStorageProvider(), session)
    expect(wrapper.find('[data-test="ready"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="submit"]').exists()).toBe(true)
  })

  it('says the report is only readable by staff', async () => {
    const { session, member } = await fixture()
    const wrapper = await mountAbsence(await storageWithGrant(member), session)
    expect(wrapper.text()).toContain('担当者')
  })

  it('emits cancel without sending anything', async () => {
    const { session, member } = await fixture()
    const wrapper = await mountAbsence(await storageWithGrant(member), session)
    await wrapper.find('[data-test="cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('cancel')).toBeTruthy()
    expect(await pending(openGroupDatabase('midori'))).toHaveLength(0)
  })
})
