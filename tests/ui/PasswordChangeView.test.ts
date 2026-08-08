// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import PasswordChangeView from '../../src/ui/PasswordChangeView.vue'
import { deleteGroupDatabase } from '../../src/db/group-db'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateEcdhKeyPair, generateEcdsaKeyPair } from '../../src/crypto/asymmetric'
import { parsePasswordChange } from '../../src/group/password-change'
import { openAsRecipient } from '../../src/inbox/uplink'
import { toBase64 } from '../../src/crypto/bytes'
import { TEST_KDF } from '../../src/crypto/kdf'
import type { Session } from '../../src/group/session'

let mounted: VueWrapper[] = []

async function fixture() {
  const staff = await generateEcdhKeyPair()
  const mine = await generateEcdhKeyPair()
  const signing = await generateEcdsaKeyPair()
  const session = {
    groupId: 'midori',
    groupName: 'みどり台',
    userId: 'u_sato',
    displayName: '佐藤 さくら',
    role: 'member',
    scopes: ['all'],
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
        {
          userId: 'u_sato',
          displayName: '佐藤 さくら',
          role: 'member',
          scopes: ['all'],
          ecdhPublic: toBase64(mine.publicKey),
          ecdsaPublic: toBase64(signing.publicKey),
        },
      ],
    },
    ecdhPrivate: mine.privateKey,
    ecdsaPrivate: signing.privateKey,
  } as unknown as Session

  return { session, staff, storage: new MemoryStorageProvider() }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
  vi.unstubAllGlobals()
})

async function mountView() {
  const { session, staff, storage } = await fixture()
  const wrapper = mount(PasswordChangeView, {
    props: { session, storage, email: 'sato@example.com', pepper: 'PEPPER', kdf: TEST_KDF },
  })
  mounted.push(wrapper)
  return { wrapper, staff, storage }
}

async function fill(wrapper: VueWrapper, value: string, confirmation = value) {
  await wrapper.get('[data-test="new-password"]').setValue(value)
  await wrapper.get('[data-test="again"]').setValue(confirmation)
  await wrapper.get('[data-test="save"]').trigger('click')
}

describe('PasswordChangeView', () => {
  it('asks for the new password twice, because a typo would lock the person out', async () => {
    const { wrapper } = await mountView()
    await fill(wrapper, 'my-own-pass', 'my-own-pas')
    expect(wrapper.get('[data-test="error"]').text()).toContain('一致')
  })

  it('sends the change to the staff, sealed', async () => {
    const { wrapper, staff, storage } = await mountView()
    await fill(wrapper, 'my-own-pass')

    await vi.waitFor(
      () => {
        if (!wrapper.find('[data-test="done"]').exists()) throw new Error('not sent yet')
      },
      { timeout: 4000, interval: 10 },
    )

    const dropped = await storage.list('midori/inbox/')
    expect(dropped).toHaveLength(1)
    const change = parsePasswordChange(
      await openAsRecipient('u_tanaka', staff.privateKey, await storage.get(dropped[0]!.path)),
    )
    expect(change.userId).toBe('u_sato')
    expect(change.email).toBe('sato@example.com')
    // 新しいパスワードそのものは通らない (包み直したキーストアだけ)
    expect(JSON.stringify(change)).not.toContain('my-own-pass')
  })

  it('says that it takes effect once the staff picks it up', async () => {
    const { wrapper } = await mountView()
    await fill(wrapper, 'my-own-pass')

    await vi.waitFor(
      () => {
        if (!wrapper.find('[data-test="done"]').exists()) throw new Error('not sent yet')
      },
      { timeout: 4000, interval: 10 },
    )
    expect(wrapper.get('[data-test="done"]').text()).toContain('担当者')
  })

  it('refuses one that is too short before sending anything', async () => {
    const { wrapper, storage } = await mountView()
    await fill(wrapper, 'short')

    await vi.waitFor(
      () => {
        if (!wrapper.find('[data-test="error"]').exists()) throw new Error('no error yet')
      },
      { timeout: 4000, interval: 10 },
    )
    expect(wrapper.get('[data-test="error"]').text()).toContain('8')
    expect(await storage.list('midori/inbox/')).toEqual([])
  })
})
