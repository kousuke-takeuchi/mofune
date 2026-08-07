// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ComposeView from '../../src/ui/ComposeView.vue'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { pending } from '../../src/sync/outbox'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import type { Session } from '../../src/group/session'
import type { StorageProvider } from '../../src/storage/provider'

async function staffSession(role: 'staff' | 'member' = 'staff'): Promise<Session> {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role,
    scopes: ['all', 'staff', 'sg_a', 'sg_a_pickup'],
    groupKeys: new Map([
      ['all:v1', await generateAesKey()],
      ['staff:v1', await generateAesKey()],
      ['sg_a:v1', await generateAesKey()],
      ['sg_a_pickup:v1', await generateAesKey()],
    ]),
    roster: {
      groupId: 'midori',
      generation: 1,
      subgroups: [
        { id: 'sg_a', name: 'Aチーム', parent: null },
        { id: 'sg_a_pickup', name: '送迎係', parent: 'sg_a' },
        { id: 'sg_b', name: 'Bチーム', parent: null },
      ],
      members: [],
    },
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

/**
 * createPost → flushOutbox は IndexedDB を何度も往復するので、固定回数の
 * flushPromises では足りない。条件が満たされるまで待つ。
 */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  await vi.waitFor(
    async () => {
      if (!(await check())) throw new Error('not settled yet')
    },
    { timeout: 2000, interval: 10 },
  )
}

async function mountCompose(storage?: StorageProvider, role?: 'staff' | 'member') {
  const wrapper = mount(ComposeView, {
    props: {
      session: await staffSession(role),
      storage: storage ?? new MemoryStorageProvider(),
    },
  })
  await flushPromises()
  return wrapper
}

describe('ComposeView', () => {
  it('offers the whole group and every subgroup the author holds a key for', async () => {
    const wrapper = await mountCompose()
    const values = wrapper
      .findAll('[data-test="scope-option"]')
      .map((option) => option.attributes('value'))
    expect(values).toContain('all')
    expect(values).toContain('sg_a')
    expect(values).toContain('sg_a_pickup')
  })

  it('does not offer a subgroup the author holds no key for', async () => {
    const wrapper = await mountCompose()
    const values = wrapper
      .findAll('[data-test="scope-option"]')
      .map((option) => option.attributes('value'))
    expect(values).not.toContain('sg_b')
  })

  it('does not offer the staff-only scope as a delivery target', async () => {
    const wrapper = await mountCompose()
    const values = wrapper
      .findAll('[data-test="scope-option"]')
      .map((option) => option.attributes('value'))
    expect(values).not.toContain('staff')
  })

  it('refuses to send with no target selected', async () => {
    const wrapper = await mountCompose()
    await wrapper.find('[data-test="body"]').setValue('こんにちは')
    await wrapper.find('[data-test="submit"]').trigger('click')
    await until(() => wrapper.find('[data-test="error"]').exists())
    expect(wrapper.find('[data-test="error"]').exists()).toBe(true)
    expect(await pending(openGroupDatabase('midori'))).toHaveLength(0)
  })

  it('refuses to send an empty body with no attachment', async () => {
    const wrapper = await mountCompose()
    await wrapper.find('[data-test="scope-option"][data-scope="sg_a"]').setValue(true)
    await wrapper.find('[data-test="submit"]').trigger('click')
    await until(() => wrapper.find('[data-test="error"]').exists())
    expect(wrapper.find('[data-test="error"]').exists()).toBe(true)
  })

  it('queues a post addressed to every selected scope', async () => {
    const storage = new MemoryStorageProvider()
    const wrapper = await mountCompose(storage)
    await wrapper.find('[data-test="body"]').setValue('来週の集まりについて')
    await wrapper.find('[data-test="scope-option"][data-scope="sg_a"]').setValue(true)
    await wrapper.find('[data-test="scope-option"][data-scope="sg_a_pickup"]').setValue(true)
    await wrapper.find('[data-test="submit"]').trigger('click')
    await until(async () => (await storage.list('midori/messages/')).length === 1)
    expect(await storage.list('midori/messages/')).toHaveLength(1)
    expect(await storage.list('midori/events/')).toHaveLength(1)
  })

  it('emits posted after a successful send', async () => {
    const wrapper = await mountCompose()
    await wrapper.find('[data-test="body"]').setValue('こんにちは')
    await wrapper.find('[data-test="scope-option"][data-scope="sg_a"]').setValue(true)
    await wrapper.find('[data-test="submit"]').trigger('click')
    await until(() => wrapper.emitted('posted') !== undefined)
    expect(wrapper.emitted('posted')).toBeTruthy()
  })

  it('keeps the post queued and tells the user when sending fails', async () => {
    const offline = {
      capabilities: { read: true, write: true, list: true, inbox: true },
      get: () => Promise.reject(new Error('offline')),
      put: () => Promise.reject(new Error('offline')),
      delete: () => Promise.reject(new Error('offline')),
      list: () => Promise.resolve([]),
    } as unknown as StorageProvider
    const wrapper = await mountCompose(offline)
    await wrapper.find('[data-test="body"]').setValue('こんにちは')
    await wrapper.find('[data-test="scope-option"][data-scope="sg_a"]').setValue(true)
    await wrapper.find('[data-test="submit"]').trigger('click')
    await until(() => wrapper.find('[data-test="queued"]').exists())
    expect(wrapper.find('[data-test="queued"]').exists()).toBe(true)
    expect(await pending(openGroupDatabase('midori'))).toHaveLength(2)
  })

  it('emits cancel without queueing anything', async () => {
    const wrapper = await mountCompose()
    await wrapper.find('[data-test="body"]').setValue('書きかけ')
    await wrapper.find('[data-test="cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toBeTruthy()
    expect(await pending(openGroupDatabase('midori'))).toHaveLength(0)
  })

  it('tells a member that they cannot post', async () => {
    const wrapper = await mountCompose(undefined, 'member')
    expect(wrapper.find('[data-test="not-allowed"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="submit"]').exists()).toBe(false)
  })
})
