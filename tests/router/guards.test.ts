// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Router } from 'vue-router'
import { createAppRouter, safeNext } from '../../src/router'
import { useSessionStore } from '../../src/stores/session'
import { registryDb } from '../../src/db/groups'
import { encodeConnectionCode } from '../../src/group/connection-code'
import type { Session } from '../../src/group/session'
import { MemoryStorageProvider } from '../../src/storage/memory'

const Blank = defineComponent({ setup: () => () => h('div') })

/** 画面の中身はガードの検証に関係しない。全部空にして遷移だけを見る。 */
function router(): Router {
  const created = createAppRouter()
  for (const route of created.getRoutes()) {
    if (typeof route.name === 'string') {
      created.addRoute({
        path: route.path,
        name: route.name,
        component: Blank,
        meta: route.meta,
      })
    }
  }
  return created
}

function signedInAs(role: 'admin' | 'staff' | 'member', emailConfirmed = true): void {
  const store = useSessionStore()
  store.session = {
    groupId: 'midori',
    groupName: 'みどり台',
    userId: 'u_1',
    displayName: '渡辺',
    role,
    scopes: [],
    groupKeys: new Map(),
    roster: { groupId: 'midori', generation: 1, subgroups: [], members: [] },
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  } as unknown as Session
  store.storage = new MemoryStorageProvider()
  store.emailConfirmed = emailConfirmed
}

async function remember(groupId: string): Promise<void> {
  await registryDb.groups.put({
    groupId,
    groupName: 'みどり台',
    code: encodeConnectionCode({
      v: 1,
      groupId,
      provider: 's3',
      root: 'https://public.invalid',
      pepper: 'p',
      adminPublicKey: 'k',
    }),
    loginId: 'watanabe',
    lastLoginAt: 1,
  })
}

beforeEach(async () => {
  setActivePinia(createPinia())
  await registryDb.groups.clear()
})

describe('guards', () => {
  it('sends a signed-out visitor with a remembered group to the unlock screen', async () => {
    await remember('midori')
    const app = router()
    await app.push('/g/midori')
    expect(app.currentRoute.value.name).toBe('unlock')
    expect(app.currentRoute.value.query.next).toBe('/g/midori')
  })

  it('sends a signed-out visitor with no record to the login screen', async () => {
    const app = router()
    await app.push('/g/midori')
    expect(app.currentRoute.value.name).toBe('login')
  })

  it('sends the root path to unlock when a group is remembered', async () => {
    await remember('midori')
    const app = router()
    await app.push('/')
    expect(app.currentRoute.value.name).toBe('unlock')
    expect(app.currentRoute.value.query.next).toBe('/g/midori')
  })

  it('sends the root path to login when nothing is remembered', async () => {
    const app = router()
    await app.push('/')
    expect(app.currentRoute.value.name).toBe('login')
  })

  it('lets a signed-in member read the timeline', async () => {
    const app = router()
    signedInAs('member')
    await app.push('/g/midori')
    expect(app.currentRoute.value.name).toBe('timeline')
  })

  it('keeps a member out of the staff screens', async () => {
    const app = router()
    signedInAs('member')
    await app.push('/g/midori/panel')
    expect(app.currentRoute.value.name).toBe('timeline')
  })

  it('lets staff into the staff screens', async () => {
    const app = router()
    signedInAs('staff')
    await app.push('/g/midori/panel')
    expect(app.currentRoute.value.name).toBe('panel')
  })

  it('holds a member on the email setup screen until it is done', async () => {
    const app = router()
    signedInAs('member', false)
    await app.push('/g/midori')
    expect(app.currentRoute.value.name).toBe('setup')
  })

  it('does not bounce a member who is already on the setup screen', async () => {
    const app = router()
    signedInAs('member', false)
    await app.push('/g/midori/setup')
    expect(app.currentRoute.value.name).toBe('setup')
  })

  it('asks to unlock when the url points at another group', async () => {
    await remember('sakura')
    const app = router()
    signedInAs('admin')
    await app.push('/g/sakura')
    expect(app.currentRoute.value.name).toBe('unlock')
  })

  it('keeps staff out of the screens that re-sign the roster', async () => {
    const app = router()
    signedInAs('staff')
    await app.push('/g/midori/members')
    expect(app.currentRoute.value.name).toBe('timeline')
  })

  it('lets an admin manage the members', async () => {
    const app = router()
    signedInAs('admin')
    await app.push('/g/midori/members')
    expect(app.currentRoute.value.name).toBe('members')
  })

  it('lets the provisioning wizard open without a session', async () => {
    const app = router()
    await app.push('/provision')
    expect(app.currentRoute.value.name).toBe('provision')
  })
})

describe('safeNext', () => {
  it('accepts a path inside the app', () => {
    expect(safeNext('/g/midori/messages/m_1')).toBe('/g/midori/messages/m_1')
  })

  it('rejects an absolute url', () => {
    expect(safeNext('https://evil.invalid/steal')).toBeNull()
  })

  it('rejects a protocol-relative url', () => {
    expect(safeNext('//evil.invalid/steal')).toBeNull()
  })

  it('rejects anything that is not a string', () => {
    expect(safeNext(undefined)).toBeNull()
    expect(safeNext(['/a', '/b'])).toBeNull()
  })
})
