// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import MessageDetailView from '../../src/ui/MessageDetailView.vue'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'

async function session(): Promise<Session> {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_sato',
    displayName: '佐藤 さくら',
    role: 'member',
    scopes: ['sg_a'],
    groupKeys: new Map([['sg_a:v1', await generateAesKey()]]),
    roster: {
      groupId: 'midori',
      generation: 1,
      subgroups: [],
      members: [
        {
          userId: 'u_tanaka',
          displayName: '田中 みか',
          role: 'staff',
          scopes: ['sg_a'],
          ecdhPublic: 'AAAA',
          ecdsaPublic: 'aaaa',
        },
      ],
    },
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:stub'),
    revokeObjectURL: vi.fn(),
  })
  const db = openGroupDatabase('midori')
  await db.messages.put({
    id: 'm_1',
    scopes: ['sg_a'],
    author: 'u_tanaka',
    at: '2026-08-07T09:12:00.000Z',
    body: '8月14日(金)10時に集合です。',
    attachments: ['f_1'],
  })
  await db.files.put({
    id: 'f_1',
    mediaType: 'image/png',
    size: 9,
    blob: utf8('png-bytes'),
    cachedAt: '2026-08-07T09:12:00.000Z',
  })
})

let mounted: VueWrapper[] = []

// DB を消す前にコンポーネントを外さないと、進行中の読み取りが未処理のまま落ちる。
afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

async function mountDetail(messageId = 'm_1') {
  const wrapper = mount(MessageDetailView, {
    props: { storage: new MemoryStorageProvider(), session: await session(), messageId },
  })
  mounted.push(wrapper)
  // 読み込みが複数段の非同期なので、落ち着くまで数ティック回す
  for (let i = 0; i < 5; i += 1) await flushPromises()
  return wrapper
}

describe('MessageDetailView', () => {
  it('shows the message body', async () => {
    expect((await mountDetail()).text()).toContain('8月14日(金)10時に集合です。')
  })

  it('shows the author display name rather than the raw user id', async () => {
    const wrapper = await mountDetail()
    expect(wrapper.text()).toContain('田中 みか')
    expect(wrapper.text()).not.toContain('u_tanaka')
  })

  it('renders an image attachment from the decrypted cache', async () => {
    const wrapper = await mountDetail()
    const image = wrapper.find('[data-test="attachment-image"]')
    expect(image.exists()).toBe(true)
    expect(image.attributes('src')).toBe('blob:stub')
  })

  it('offers a download link for a non-image attachment', async () => {
    await openGroupDatabase('midori').files.put({
      id: 'f_1',
      mediaType: 'application/pdf',
      size: 3,
      blob: utf8('pdf'),
      cachedAt: '2026-08-07T09:12:00.000Z',
    })
    const wrapper = await mountDetail()
    expect(wrapper.find('[data-test="attachment-image"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="attachment-link"]').exists()).toBe(true)
  })

  it('shows a placeholder when an attachment has not been fetched yet', async () => {
    await openGroupDatabase('midori').files.clear()
    const wrapper = await mountDetail()
    expect(wrapper.find('[data-test="attachment-missing"]').exists()).toBe(true)
  })

  it('advances lastReadAt when the message is opened', async () => {
    const db = openGroupDatabase('midori')
    expect(await db.syncState.get('lastReadAt')).toBeUndefined()
    await mountDetail()
    const stored = (await db.syncState.get('lastReadAt'))?.value
    expect(stored).not.toBeNull()
    expect(Date.parse(stored ?? '')).not.toBeNaN()
  })

  it('never sends the read state anywhere', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await mountDetail()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a message that is not in the cache', async () => {
    const wrapper = await mountDetail('m_missing')
    expect(wrapper.find('[data-test="not-found"]').exists()).toBe(true)
  })

  it('emits back when the back control is used', async () => {
    const wrapper = await mountDetail()
    await wrapper.find('[data-test="back"]').trigger('click')
    expect(wrapper.emitted('back')).toBeTruthy()
  })

  it('revokes the object URL when unmounted', async () => {
    const wrapper = await mountDetail()
    wrapper.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stub')
  })
})
