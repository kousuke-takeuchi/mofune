# ルーティングとセッション復帰 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** リロードしても画面の位置が消えないようにする。URL が画面を表し、再開時はパスワードだけで元の画面へ戻る。

**Architecture:** vue-router (hash mode) が「いまどの画面か」を持ち、Pinia の `useSessionStore` が「誰としてログインしているか」だけを持つ。既存の `src/ui/*.vue` は props/emit のまま触らず、`src/pages/` の薄いアダプタがストアとルータに繋ぐ。`App.vue` は `<RouterView />` だけになる。

**Tech Stack:** Vue 3 / TypeScript / vue-router / Pinia / Vite / Vitest / Dexie.js

正は [設計](../specs/2026-08-08-routing-and-session-restore-design.md)。

## Global Constraints

- 秘密鍵・パスワード・ストレージ資格情報を IndexedDB / localStorage / sessionStorage に保存してはならない
- バイト列の型は `Bytes` (= `Uint8Array<ArrayBuffer>`、`src/crypto/bytes.ts`)
- **`noUnusedLocals` が有効。** 各タスクで `npm run typecheck` まで通してからコミットする
- UI テストの待機は `vi.waitFor` で「実際に検証したい条件」を待つ。固定回数の `flushPromises` に頼らない
- 本番の KDF パラメータをテストで使わない。テストは `TEST_KDF`
- テストは `tests/**/*.test.ts`。`import { describe, it, expect } from 'vitest'` を明示する
- DOM が要るテストはファイル先頭に `// @vitest-environment happy-dom`
- happy-dom では `type="submit"` のクリックがフォーム送信を起こさない。`type="button"` + `@click` にする
- **既存の `tests/ui/*.test.ts` 10本を変更しない。** 壊れないことが分離できている証拠になる
- Pinia のテストは各テストで `createPinia()` を作り直し、状態を持ち越さない
- `vitest` の出力は rtk フックに握り潰される。`rtk proxy npx vitest run ...` を使う
- コミットは Conventional Commits 形式。`Co-Authored-By` 行は付けない
- 実行時に外部CDNへ接続しない

## 既存インターフェース(実装前に確認済み)

```ts
// src/group/session.ts
interface Session { groupId; groupName; userId; displayName; role: Role; scopes: string[];
                    groupKeys: Map<string, CryptoKey>; roster: RosterContents;
                    ecdhPrivate: Bytes; ecdsaPrivate: Bytes }
login(options: { code: ConnectionCode; loginId: string; password: string; storage: StorageProvider }): Promise<Session>
class LoginError extends Error {}

// src/db/groups.ts
interface StoredGroup { groupId; groupName; code: string; loginId: string; lastLoginAt: number }
rememberGroup(input: { code: ConnectionCode; groupName: string; loginId: string; at: number }): Promise<void>
listGroups(): Promise<StoredGroup[]>
getGroup(groupId: string): Promise<{ code: ConnectionCode; groupName: string; loginId: string } | undefined>
forgetGroup(groupId: string): Promise<void>
registryDb  // Dexie インスタンス。テストで clear する

// src/group/connection-code.ts
decodeConnectionCode(text: string): ConnectionCode
interface ConnectionCode { v; groupId; provider; root; pepper; adminPublicKey }

// src/group/email-registration.ts
isEmailConfirmed(db): Promise<boolean>
// src/db/group-db.ts
openGroupDatabase(groupId: string)
// src/storage/http.ts
class HttpStorageProvider implements StorageProvider { constructor(root: string) }
// src/crypto/bytes.ts
fromBase64(text: string): Bytes

// 既存ビューの props / emit (変更しない)
LoginView            emit: login[session, root, adminPublicKey]
TimelineView         props: { session, storage }              emit: open[messageId]
MessageDetailView    props: { session, messageId }            emit: back[]
ComposeView          props: { session, storage }              emit: posted[messageId], cancel[]
NotifyView           props: { session, storage, messageId }   emit: close[]
AbsenceView          props: { session, storage }              emit: sent[], cancel[]
AbsenceListView      props: { session }                       emit: close[]
StaffPanelView       props: { session, storage, adminPublicKey: Bytes }  emit: close[]
SetupView            props: { session, storage }              emit: done[]
ProvisionWizardView  props: { kdf?, createStorage? }          emit: done[connectionCode], cancel[]
```

## File Structure

```
src/stores/session.ts          セッション1つ。signIn / unlock / signOut        Task 2
src/stores/groups.ts           端末に記録済みのグループ一覧                    Task 2
src/router/index.ts            ルート表とガード                                Task 3, 4
src/pages/*.vue                1画面1つの薄いアダプタ (11本)                   Task 5, 6
src/ui/UnlockView.vue          パスワード欄だけの再認証フォーム                Task 5
src/App.vue                    <RouterView /> だけに置き換え                   Task 6
src/main.ts                    createPinia / router を差す                     Task 6
```

---

### Task 1: vue-router と Pinia を入れる

**Files:**
- Modify: `package.json`
- Modify: `src/main.ts`

**Interfaces:**
- Produces: `pinia` / `vue-router` が依存に入り、`createPinia()` と `createRouter()` が使えるようになる

このタスクだけはテストを先に書かない。依存の追加はテストで表現できることが無く、次のタスクの前提にしかならないため。次のタスクで最初のテストが入る。

- [ ] **Step 1: 依存を追加する**

```bash
npm install vue-router pinia
```

- [ ] **Step 2: 入っていることを確かめる**

```bash
node -e "console.log(require('./package.json').dependencies)"
```

Expected: `vue-router` と `pinia` が並ぶ。

- [ ] **Step 3: 既存のテストと型が壊れていないことを確かめる**

```bash
rtk proxy npx vitest run && npm run typecheck
```

Expected: 全て green。

- [ ] **Step 4: コミット**

```bash
git add package.json package-lock.json
git commit -m "build: add vue-router and pinia"
```

---

### Task 2: セッションとグループのストア

**Files:**
- Create: `src/stores/session.ts`
- Create: `src/stores/groups.ts`
- Test: `tests/stores/session.test.ts`

**Interfaces:**
- Consumes: `login` / `Session` / `LoginError`、`HttpStorageProvider`、`getGroup` / `rememberGroup` / `listGroups` / `forgetGroup`、`isEmailConfirmed` / `openGroupDatabase`、`fromBase64` / `Bytes`、`ConnectionCode`
- Produces:
  - `useSessionStore()` — state `{ session: Session | null; storage: StorageProvider | null; adminPublicKey: Bytes; emailConfirmed: boolean }`、getters `isSignedIn: boolean` / `groupId: string | null` / `role: Role | null`、actions `signIn(code: ConnectionCode, loginId: string, password: string): Promise<void>` / `unlock(groupId: string, password: string): Promise<void>` / `signOut(): void`
  - `useGroupsStore()` — state `{ groups: StoredGroup[] }`、actions `load(): Promise<void>` / `forget(groupId: string): Promise<void>`、getters `lastGroupId: string | null`

`signIn` は今 `LoginView` と `App.vue` に散っている「ログイン → ストレージ生成 → 端末に記録 → メール登録の判定」をひとまとめにする。`unlock` は registry から接続コードとログインIDを読み、同じ経路を通る。

**鍵は決してストアの外へ出さない。** 永続化するのは `rememberGroup` が書く接続コードとログインIDだけで、これは秘密情報ではない。

- [ ] **Step 1: 失敗するテストを書く**

`tests/stores/session.test.ts`:

```ts
// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from '../../src/stores/session'
import { useGroupsStore } from '../../src/stores/groups'
import { provisionGroup, writeObjects } from '../../src/group/provision'
import { decodeConnectionCode, encodeConnectionCode } from '../../src/group/connection-code'
import type { ConnectionCode } from '../../src/group/connection-code'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { registryDb } from '../../src/db/groups'

const ROOT = 'https://public.invalid'

async function buildGroup(): Promise<{ code: ConnectionCode; storage: MemoryStorageProvider }> {
  const result = await provisionGroup({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    provider: 's3',
    root: ROOT,
    kdf: TEST_KDF,
    subgroups: [],
    members: [
      {
        loginId: 'watanabe',
        displayName: '渡辺 けい',
        role: 'admin',
        scopes: [],
        password: 'admin-pass',
        email: 'watanabe@example.invalid',
      },
    ],
  })
  const storage = new MemoryStorageProvider()
  await writeObjects(storage, result.objects)
  return { code: decodeConnectionCode(encodeConnectionCode(result.code)), storage }
}

/** 参加者と同じく、資格情報なしの GET でしか読めない状態を作る。 */
function routeFetchTo(storage: MemoryStorageProvider): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.startsWith(`${ROOT}/`)) return new Response(null, { status: 404 })
      try {
        return new Response(await storage.get(url.slice(ROOT.length + 1)))
      } catch {
        return new Response(null, { status: 404 })
      }
    }),
  )
}

beforeEach(async () => {
  setActivePinia(createPinia())
  await registryDb.groups.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useSessionStore', () => {
  it('starts signed out', () => {
    expect(useSessionStore().isSignedIn).toBe(false)
  })

  it('signs in and exposes the group', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    const session = useSessionStore()
    await session.signIn(code, 'watanabe', 'admin-pass')
    expect(session.isSignedIn).toBe(true)
    expect(session.groupId).toBe('midori')
    expect(session.role).toBe('admin')
  })

  it('remembers the group on the device so it can be unlocked later', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    await useSessionStore().signIn(code, 'watanabe', 'admin-pass')
    const groups = useGroupsStore()
    await groups.load()
    expect(groups.groups.map((group) => group.groupId)).toEqual(['midori'])
    expect(groups.lastGroupId).toBe('midori')
  })

  it('unlocks with the password alone once the group is remembered', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    await useSessionStore().signIn(code, 'watanabe', 'admin-pass')

    // リロード相当。ストアを作り直すとセッションは消える。
    setActivePinia(createPinia())
    const revived = useSessionStore()
    expect(revived.isSignedIn).toBe(false)

    await revived.unlock('midori', 'admin-pass')
    expect(revived.isSignedIn).toBe(true)
    expect(revived.groupId).toBe('midori')
  })

  it('refuses to unlock with the wrong password', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    await useSessionStore().signIn(code, 'watanabe', 'admin-pass')

    setActivePinia(createPinia())
    await expect(useSessionStore().unlock('midori', 'wrong')).rejects.toThrow()
  })

  it('refuses to unlock a group the device does not know', async () => {
    await expect(useSessionStore().unlock('unknown', 'admin-pass')).rejects.toThrow()
  })

  it('drops everything on sign out', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    const session = useSessionStore()
    await session.signIn(code, 'watanabe', 'admin-pass')
    session.signOut()
    expect(session.isSignedIn).toBe(false)
    expect(session.storage).toBeNull()
  })

  it('treats non-members as having a confirmed email', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    const session = useSessionStore()
    await session.signIn(code, 'watanabe', 'admin-pass')
    expect(session.emailConfirmed).toBe(true)
  })
})

describe('useGroupsStore', () => {
  it('has no group before anyone signs in', async () => {
    const groups = useGroupsStore()
    await groups.load()
    expect(groups.lastGroupId).toBeNull()
  })

  it('forgets a group on request', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    await useSessionStore().signIn(code, 'watanabe', 'admin-pass')
    const groups = useGroupsStore()
    await groups.load()
    await groups.forget('midori')
    expect(groups.groups).toHaveLength(0)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
rtk proxy npx vitest run tests/stores/session.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/stores/session"`

- [ ] **Step 3: 実装する**

`src/stores/groups.ts`:

```ts
import { defineStore } from 'pinia'
import type { StoredGroup } from '../db/groups'
import { forgetGroup, listGroups } from '../db/groups'

/** 端末に記録済みのグループ。接続コードとログインIDだけで、秘密は含まない。 */
export const useGroupsStore = defineStore('groups', {
  state: () => ({ groups: [] as StoredGroup[] }),
  getters: {
    lastGroupId(state): string | null {
      return state.groups[0]?.groupId ?? null
    },
  },
  actions: {
    async load(): Promise<void> {
      this.groups = await listGroups()
    },
    async forget(groupId: string): Promise<void> {
      await forgetGroup(groupId)
      await this.load()
    },
  },
})
```

`src/stores/session.ts`:

```ts
import { defineStore } from 'pinia'
import type { Bytes } from '../crypto/bytes'
import { fromBase64 } from '../crypto/bytes'
import { openGroupDatabase } from '../db/group-db'
import { getGroup, rememberGroup } from '../db/groups'
import type { ConnectionCode } from '../group/connection-code'
import { isEmailConfirmed } from '../group/email-registration'
import type { Role, Session } from '../group/session'
import { login } from '../group/session'
import { HttpStorageProvider } from '../storage/http'
import type { StorageProvider } from '../storage/provider'
import { useGroupsStore } from './groups'

export class UnknownGroupError extends Error {}

interface SessionState {
  session: Session | null
  storage: StorageProvider | null
  adminPublicKey: Bytes
  emailConfirmed: boolean
}

/**
 * いま解錠されているセッション1つ。リロードで消える。
 *
 * 鍵とパスワードは永続化しない(要件書 §5)。端末に残すのは接続コードと
 * ログインIDだけで、再開時はパスワードだけを訊く。
 */
export const useSessionStore = defineStore('session', {
  state: (): SessionState => ({
    session: null,
    storage: null,
    adminPublicKey: new Uint8Array(0),
    emailConfirmed: true,
  }),
  getters: {
    isSignedIn: (state): boolean => state.session !== null && state.storage !== null,
    groupId: (state): string | null => state.session?.groupId ?? null,
    role: (state): Role | null => state.session?.role ?? null,
  },
  actions: {
    async signIn(code: ConnectionCode, loginId: string, password: string): Promise<void> {
      const storage = new HttpStorageProvider(code.root)
      const session = await login({ code, loginId, password, storage })

      this.session = session
      this.storage = storage
      this.adminPublicKey = fromBase64(code.adminPublicKey)
      // メールアドレス未登録の参加者は、登録が済むまで主要機能をロックする(要件書 §4.6)
      this.emailConfirmed =
        session.role !== 'member' || (await isEmailConfirmed(openGroupDatabase(session.groupId)))

      await rememberGroup({
        code,
        groupName: session.groupName,
        loginId,
        at: Date.now(),
      })
      await useGroupsStore().load()
    },

    async unlock(groupId: string, password: string): Promise<void> {
      const stored = await getGroup(groupId)
      if (!stored) {
        throw new UnknownGroupError('この端末にはこのグループの記録がありません')
      }
      await this.signIn(stored.code, stored.loginId, password)
    },

    signOut(): void {
      this.session = null
      this.storage = null
      this.adminPublicKey = new Uint8Array(0)
      this.emailConfirmed = true
    },
  },
})
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
rtk proxy npx vitest run tests/stores/session.test.ts && npm run typecheck
```

Expected: 10 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/stores tests/stores
git commit -m "feat(stores): hold the session in pinia and remember groups on the device"
```

---

### Task 3: ルート表

**Files:**
- Create: `src/router/index.ts`
- Test: `tests/router/routes.test.ts`

**Interfaces:**
- Consumes: Task 5・6 で作るページ(この時点では未作成なので、**遅延 import で書く**)
- Produces: `createAppRouter(): Router`、`type RouteName`

ページはまだ無いので、ルートの `component` は `() => import('../pages/XxxPage.vue')` で書く。遅延 import なら、実際に遷移するまで読み込まれない。このタスクのテストは path と name の対応だけを見るので、ページが無くても通る。

**Task 5 の前にこのタスクを終える理由**は、ページ側が `router.push({ name: 'message' })` と名前で遷移するため、名前の一覧が先に決まっている必要があるから。

- [ ] **Step 1: 失敗するテストを書く**

`tests/router/routes.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { createAppRouter } from '../../src/router'

describe('routes', () => {
  it('uses hash urls so a reload does not 404 on github pages', () => {
    expect(createAppRouter().resolve({ name: 'login' }).href).toBe('#/login')
  })

  it('maps every screen to a url', () => {
    const paths = createAppRouter()
      .getRoutes()
      .map((route) => route.path)
      .sort()
    expect(paths).toEqual(
      [
        '/',
        '/g/:groupId',
        '/g/:groupId/absence',
        '/g/:groupId/absences',
        '/g/:groupId/compose',
        '/g/:groupId/messages/:messageId',
        '/g/:groupId/messages/:messageId/notify',
        '/g/:groupId/panel',
        '/g/:groupId/setup',
        '/login',
        '/provision',
        '/unlock',
        '/:pathMatch(.*)*',
      ].sort(),
    )
  })

  it('names the screens the pages navigate to', () => {
    const names = createAppRouter()
      .getRoutes()
      .map((route) => route.name)
      .filter((name): name is string => typeof name === 'string')
    for (const name of [
      'home',
      'login',
      'unlock',
      'provision',
      'timeline',
      'message',
      'notify',
      'compose',
      'absence',
      'absences',
      'panel',
      'setup',
    ]) {
      expect(names).toContain(name)
    }
  })

  it('marks the screens that only staff may open', () => {
    const staffOnly = createAppRouter()
      .getRoutes()
      .filter((route) => route.meta.staffOnly)
      .map((route) => route.name)
    expect(staffOnly.sort()).toEqual(['absences', 'compose', 'notify', 'panel'])
  })

  it('marks the screens that do not need a session', () => {
    const publicNames = createAppRouter()
      .getRoutes()
      .filter((route) => route.meta.public)
      .map((route) => route.name)
    expect(publicNames.sort()).toEqual(['home', 'login', 'provision', 'unlock'])
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
rtk proxy npx vitest run tests/router/routes.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/router"`

- [ ] **Step 3: 実装する**

`src/router/index.ts`:

```ts
import { createRouter, createWebHashHistory } from 'vue-router'
import type { Router, RouteRecordRaw } from 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    /** セッションが無くても開ける */
    public?: boolean
    /** 参加者には開かせない */
    staffOnly?: boolean
  }
}

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: () => import('../pages/HomePage.vue'), meta: { public: true } },
  { path: '/login', name: 'login', component: () => import('../pages/LoginPage.vue'), meta: { public: true } },
  { path: '/unlock', name: 'unlock', component: () => import('../pages/UnlockPage.vue'), meta: { public: true } },
  {
    path: '/provision',
    name: 'provision',
    component: () => import('../pages/ProvisionPage.vue'),
    meta: { public: true },
  },
  { path: '/g/:groupId', name: 'timeline', component: () => import('../pages/TimelinePage.vue') },
  {
    path: '/g/:groupId/messages/:messageId',
    name: 'message',
    component: () => import('../pages/MessagePage.vue'),
  },
  {
    path: '/g/:groupId/messages/:messageId/notify',
    name: 'notify',
    component: () => import('../pages/NotifyPage.vue'),
    meta: { staffOnly: true },
  },
  {
    path: '/g/:groupId/compose',
    name: 'compose',
    component: () => import('../pages/ComposePage.vue'),
    meta: { staffOnly: true },
  },
  { path: '/g/:groupId/absence', name: 'absence', component: () => import('../pages/AbsencePage.vue') },
  {
    path: '/g/:groupId/absences',
    name: 'absences',
    component: () => import('../pages/AbsenceListPage.vue'),
    meta: { staffOnly: true },
  },
  {
    path: '/g/:groupId/panel',
    name: 'panel',
    component: () => import('../pages/PanelPage.vue'),
    meta: { staffOnly: true },
  },
  { path: '/g/:groupId/setup', name: 'setup', component: () => import('../pages/SetupPage.vue') },
  { path: '/:pathMatch(.*)*', redirect: { name: 'home' } },
]

/**
 * hash history を使う。GitHub Pages は SPA のフォールバックを持たないため、
 * history mode だと直接アクセスとリロードが 404 になる。
 */
export function createAppRouter(): Router {
  return createRouter({ history: createWebHashHistory(), routes })
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
rtk proxy npx vitest run tests/router/routes.test.ts && npm run typecheck
```

Expected: 5 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/router tests/router
git commit -m "feat(router): map every screen to a hash url"
```

---

### Task 4: ガード

**Files:**
- Modify: `src/router/index.ts`
- Test: `tests/router/guards.test.ts`

**Interfaces:**
- Consumes: `useSessionStore` / `useGroupsStore`、`createAppRouter`
- Produces: `installGuards(router: Router): void`(`createAppRouter` の中から呼ぶ)、`safeNext(next: unknown): string | null`(export してテストする)

ガードのテストは、ページの中身に触れずに `router.push` の行き先だけを見る。ページはまだ実装が無いので、**このタスクのテストでは全ルートの component を差し替える**。`router.addRoute` で同じ name のルートを上書きすると component だけ入れ替えられる。

- [ ] **Step 1: 失敗するテストを書く**

`tests/router/guards.test.ts`:

```ts
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
      created.addRoute({ ...route, component: Blank, children: [] })
    }
  }
  return created
}

function signedInAs(role: 'admin' | 'staff' | 'member', emailConfirmed = true): void {
  const store = useSessionStore()
  store.session = { groupId: 'midori', groupName: 'みどり台', userId: 'u_1', displayName: '渡辺',
    role, scopes: [], groupKeys: new Map(), roster: { groupId: 'midori', generation: 1,
    subgroups: [], members: [] }, ecdhPrivate: new Uint8Array(0), ecdsaPrivate: new Uint8Array(0),
  } as unknown as Session
  store.storage = new MemoryStorageProvider()
  store.emailConfirmed = emailConfirmed
}

async function remember(groupId: string): Promise<void> {
  await registryDb.groups.put({
    groupId,
    groupName: 'みどり台',
    code: encodeConnectionCode({
      v: 1, groupId, provider: 's3', root: 'https://public.invalid', pepper: 'p', adminPublicKey: 'k',
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
rtk proxy npx vitest run tests/router/guards.test.ts
```

Expected: FAIL — `safeNext` が `src/router` に無い。

- [ ] **Step 3: 実装する**

`src/router/index.ts` の末尾に足し、`createAppRouter` から呼ぶ:

```ts
import { useGroupsStore } from '../stores/groups'
import { useSessionStore } from '../stores/session'

/**
 * 戻り先はアプリ内の相対パスだけ受け付ける。細工したリンクで
 * 別サイトへ飛ばされないようにするため。
 */
export function safeNext(next: unknown): string | null {
  if (typeof next !== 'string') return null
  if (!next.startsWith('/')) return null
  if (next.startsWith('//')) return null
  return next
}

export function installGuards(router: Router): void {
  router.beforeEach(async (to) => {
    const session = useSessionStore()

    if (to.name === 'home') {
      const groups = useGroupsStore()
      await groups.load()
      const groupId = groups.lastGroupId
      if (!groupId) return { name: 'login' }
      if (session.isSignedIn && session.groupId === groupId) {
        return { name: 'timeline', params: { groupId } }
      }
      return { name: 'unlock', query: { next: `/g/${groupId}` } }
    }

    if (to.meta.public) return true

    const groupId = String(to.params.groupId ?? '')

    if (!session.isSignedIn || session.groupId !== groupId) {
      const groups = useGroupsStore()
      await groups.load()
      const known = groups.groups.some((group) => group.groupId === groupId)
      const query = { next: to.fullPath }
      return known ? { name: 'unlock', query } : { name: 'login', query }
    }

    if (to.meta.staffOnly && session.role === 'member') {
      return { name: 'timeline', params: { groupId } }
    }

    // メールアドレス未登録の参加者は、登録が済むまで主要機能をロックする(要件書 §4.6)
    if (session.role === 'member' && !session.emailConfirmed && to.name !== 'setup') {
      return { name: 'setup', params: { groupId } }
    }

    return true
  })
}
```

`createAppRouter` を次のように変える:

```ts
export function createAppRouter(): Router {
  const router = createRouter({ history: createWebHashHistory(), routes })
  installGuards(router)
  return router
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
rtk proxy npx vitest run tests/router 2>&1 | tail -20 && npm run typecheck
```

Expected: 20 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/router tests/router
git commit -m "feat(router): guard the screens and remember where to return"
```

---

### Task 5: 再認証の画面とページ層(前半)

**Files:**
- Create: `src/ui/UnlockView.vue`
- Create: `src/pages/HomePage.vue`
- Create: `src/pages/UnlockPage.vue`
- Create: `src/pages/LoginPage.vue`
- Create: `src/pages/ProvisionPage.vue`
- Test: `tests/pages/UnlockPage.test.ts`

**Interfaces:**
- Consumes: `useSessionStore` / `useGroupsStore`、`getGroup`、`LoginView`、`ProvisionWizardView`、`safeNext`
- Produces: `UnlockView.vue`(props `{ groupName: string; loginId: string; busy: boolean; error: string }`、emit `unlock[password]` / `switchGroup[]` / `forget[]`)と、上記4ページ

`HomePage` は描画しない。ガードが `home` を必ず他所へ飛ばすので、到達しても空でよい。

- [ ] **Step 1: 失敗するテストを書く**

`tests/pages/UnlockPage.test.ts`:

```ts
// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import UnlockPage from '../../src/pages/UnlockPage.vue'
import { useSessionStore } from '../../src/stores/session'
import { registryDb } from '../../src/db/groups'
import { encodeConnectionCode } from '../../src/group/connection-code'

const push = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ query: { next: '/g/midori/messages/m_1' } }),
}))

async function remember(): Promise<void> {
  await registryDb.groups.put({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    code: encodeConnectionCode({
      v: 1, groupId: 'midori', provider: 's3', root: 'https://public.invalid',
      pepper: 'p', adminPublicKey: 'k',
    }),
    loginId: 'watanabe',
    lastLoginAt: 1,
  })
}

beforeEach(async () => {
  setActivePinia(createPinia())
  push.mockClear()
  await registryDb.groups.clear()
  await remember()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('UnlockPage', () => {
  it('shows the group and the login id it will use', async () => {
    const wrapper = mount(UnlockPage)
    await vi.waitFor(() => {
      if (!wrapper.text().includes('みどり台グループ')) throw new Error('not loaded')
    })
    expect(wrapper.text()).toContain('watanabe')
  })

  it('asks for the password only', async () => {
    const wrapper = mount(UnlockPage)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="password"]').exists()) throw new Error('not loaded')
    })
    expect(wrapper.find('[data-test="code"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="login-id"]').exists()).toBe(false)
  })

  it('returns to the screen the visitor came from', async () => {
    const session = useSessionStore()
    vi.spyOn(session, 'unlock').mockResolvedValue(undefined)
    const wrapper = mount(UnlockPage)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="password"]').exists()) throw new Error('not loaded')
    })
    await wrapper.find('[data-test="password"]').setValue('admin-pass')
    await wrapper.find('[data-test="unlock"]').trigger('click')
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/g/midori/messages/m_1'))
  })

  it('shows why the password was refused', async () => {
    const session = useSessionStore()
    vi.spyOn(session, 'unlock').mockRejectedValue(new Error('ログインIDまたはパスワードが正しくありません'))
    const wrapper = mount(UnlockPage)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="password"]').exists()) throw new Error('not loaded')
    })
    await wrapper.find('[data-test="password"]').setValue('wrong')
    await wrapper.find('[data-test="unlock"]').trigger('click')
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="error"]').text()).toContain('パスワード'),
    )
    expect(push).not.toHaveBeenCalled()
  })

  it('offers a way to sign in as another group', async () => {
    const wrapper = mount(UnlockPage)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="switch-group"]').exists()) throw new Error('not loaded')
    })
    await wrapper.find('[data-test="switch-group"]').trigger('click')
    expect(push).toHaveBeenCalledWith({ name: 'login' })
  })

  it('forgets the device record on request', async () => {
    const wrapper = mount(UnlockPage)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="forget"]').exists()) throw new Error('not loaded')
    })
    await wrapper.find('[data-test="forget"]').trigger('click')
    await vi.waitFor(async () => {
      expect(await registryDb.groups.count()).toBe(0)
    })
    expect(push).toHaveBeenCalledWith({ name: 'login' })
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
rtk proxy npx vitest run tests/pages/UnlockPage.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/pages/UnlockPage.vue"`

- [ ] **Step 3: 実装する**

`src/ui/UnlockView.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ groupName: string; loginId: string; busy: boolean; error: string }>()
const emit = defineEmits<{ unlock: [password: string]; switchGroup: []; forget: [] }>()

const password = ref('')
</script>

<template>
  <section>
    <h1>おかえりなさい</h1>
    <p>{{ groupName }} — {{ loginId }}</p>

    <label>
      パスワード
      <input
        v-model="password"
        data-test="password"
        type="password"
        autocomplete="current-password"
      />
    </label>

    <p v-if="error" data-test="error" role="alert">{{ error }}</p>

    <button type="button" data-test="unlock" :disabled="busy" @click="emit('unlock', password)">
      {{ busy ? '確認しています…' : '開く' }}
    </button>

    <button type="button" data-test="switch-group" @click="emit('switchGroup')">
      別のグループに入る
    </button>
    <button type="button" data-test="forget" @click="emit('forget')">
      この端末の記録を消す
    </button>
  </section>
</template>
```

`src/pages/UnlockPage.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UnlockView from '../ui/UnlockView.vue'
import { safeNext } from '../router'
import { useGroupsStore } from '../stores/groups'
import { useSessionStore } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const groups = useGroupsStore()

const groupId = ref('')
const groupName = ref('')
const loginId = ref('')
const busy = ref(false)
const error = ref('')

/** 戻り先の /g/<id>/... から、どのグループを解錠するかを読む。 */
function groupIdFromNext(next: string | null): string | null {
  return next?.match(/^\/g\/([^/]+)/)?.[1] ?? null
}

onMounted(async () => {
  await groups.load()
  const wanted = groupIdFromNext(safeNext(route.query.next)) ?? groups.lastGroupId
  const stored = groups.groups.find((group) => group.groupId === wanted)
  if (!stored) {
    await router.push({ name: 'login' })
    return
  }
  groupId.value = stored.groupId
  groupName.value = stored.groupName
  loginId.value = stored.loginId
})

async function unlock(password: string): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    await session.unlock(groupId.value, password)
    const next = safeNext(route.query.next)
    await router.push(next ?? `/g/${groupId.value}`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function forget(): Promise<void> {
  await groups.forget(groupId.value)
  await router.push({ name: 'login' })
}
</script>

<template>
  <UnlockView
    :group-name="groupName"
    :login-id="loginId"
    :busy="busy"
    :error="error"
    @unlock="unlock"
    @switch-group="router.push({ name: 'login' })"
    @forget="forget"
  />
</template>
```

`src/pages/HomePage.vue`:

```vue
<script setup lang="ts">
// ガードが必ず他の画面へ飛ばすので、ここは描画しない。
</script>

<template>
  <div />
</template>
```

`src/pages/LoginPage.vue`:

```vue
<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import LoginView from '../ui/LoginView.vue'
import { safeNext } from '../router'
import type { Session } from '../group/session'
import { useSessionStore } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

/**
 * LoginView は自分でログインを済ませてセッションを渡してくる。
 * ストアはその結果を受け取るだけにして、二重にログインしない。
 */
async function onLogin(next: Session, root: string, adminPublicKey: string): Promise<void> {
  await session.adopt(next, root, adminPublicKey)
  const back = safeNext(route.query.next)
  await router.push(back ?? { name: 'timeline', params: { groupId: next.groupId } })
}
</script>

<template>
  <LoginView @login="onLogin" />
  <button type="button" data-test="provision" @click="router.push({ name: 'provision' })">
    グループを作る
  </button>
</template>
```

`adopt` を `src/stores/session.ts` に足す(`signIn` と重複する部分は `adopt` に寄せる):

```ts
    /** すでに解錠済みのセッションを受け取る。LoginView が自分でログインするため。 */
    async adopt(session: Session, root: string, adminPublicKey: string): Promise<void> {
      this.session = session
      this.storage = new HttpStorageProvider(root)
      this.adminPublicKey = fromBase64(adminPublicKey)
      this.emailConfirmed =
        session.role !== 'member' || (await isEmailConfirmed(openGroupDatabase(session.groupId)))
      await useGroupsStore().load()
    },
```

`signIn` は `adopt` を使う形に直す:

```ts
    async signIn(code: ConnectionCode, loginId: string, password: string): Promise<void> {
      const storage = new HttpStorageProvider(code.root)
      const session = await login({ code, loginId, password, storage })
      await rememberGroup({ code, groupName: session.groupName, loginId, at: Date.now() })
      await this.adopt(session, code.root, code.adminPublicKey)
    },
```

`src/pages/ProvisionPage.vue`:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router'
import ProvisionWizardView from '../ui/ProvisionWizardView.vue'

const router = useRouter()
</script>

<template>
  <ProvisionWizardView
    @done="router.push({ name: 'login' })"
    @cancel="router.push({ name: 'login' })"
  />
</template>
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
rtk proxy npx vitest run tests/pages tests/stores && npm run typecheck
```

Expected: UnlockPage 6 tests + stores 10 tests が passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/ui/UnlockView.vue src/pages src/stores tests/pages
git commit -m "feat(ui): ask only for the password when returning to a known group"
```

---

### Task 6: 残りのページと App の置き換え

**Files:**
- Create: `src/pages/TimelinePage.vue`
- Create: `src/pages/MessagePage.vue`
- Create: `src/pages/ComposePage.vue`
- Create: `src/pages/NotifyPage.vue`
- Create: `src/pages/AbsencePage.vue`
- Create: `src/pages/AbsenceListPage.vue`
- Create: `src/pages/PanelPage.vue`
- Create: `src/pages/SetupPage.vue`
- Modify: `src/App.vue`
- Modify: `src/main.ts`
- Test: `tests/pages/TimelinePage.test.ts`

**Interfaces:**
- Consumes: `useSessionStore`、既存ビュー8本、`createAppRouter`
- Produces: 8ページと、`<RouterView />` だけになった `App.vue`

ページは全部同じ形になる。ストアから `session` と `storage` を取り、無ければ何も描かない(ガードが弾くので実際には起きないが、型の非 null 化のために要る)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/pages/TimelinePage.test.ts`:

```ts
// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TimelinePage from '../../src/pages/TimelinePage.vue'
import { useSessionStore } from '../../src/stores/session'
import type { Session } from '../../src/group/session'
import { MemoryStorageProvider } from '../../src/storage/memory'

const push = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ params: { groupId: 'midori' } }),
}))

function signIn(role: 'admin' | 'member'): void {
  const store = useSessionStore()
  store.session = {
    groupId: 'midori', groupName: 'みどり台', userId: 'u_1', displayName: '渡辺', role,
    scopes: [], groupKeys: new Map(),
    roster: { groupId: 'midori', generation: 1, subgroups: [], members: [] },
    ecdhPrivate: new Uint8Array(0), ecdsaPrivate: new Uint8Array(0),
  } as unknown as Session
  store.storage = new MemoryStorageProvider()
}

beforeEach(() => {
  setActivePinia(createPinia())
  push.mockClear()
})

describe('TimelinePage', () => {
  it('opens a message by url', async () => {
    signIn('admin')
    const wrapper = mount(TimelinePage)
    wrapper.findComponent({ name: 'TimelineView' }).vm.$emit('open', 'm_1')
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith({
        name: 'message',
        params: { groupId: 'midori', messageId: 'm_1' },
      }),
    )
  })

  it('offers the staff actions to staff', () => {
    signIn('admin')
    const wrapper = mount(TimelinePage)
    expect(wrapper.find('[data-test="compose"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="staff-panel"]').exists()).toBe(true)
  })

  it('hides the staff actions from members', () => {
    signIn('member')
    const wrapper = mount(TimelinePage)
    expect(wrapper.find('[data-test="compose"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="staff-panel"]').exists()).toBe(false)
  })

  it('always offers the absence report', () => {
    signIn('member')
    expect(mount(TimelinePage).find('[data-test="report"]').exists()).toBe(true)
  })
})
```

`TimelineView` に `name` は付いていないので、`findComponent({ name: 'TimelineView' })` が効くよう、`src/ui/TimelineView.vue` に `defineOptions({ name: 'TimelineView' })` を足す。**これは既存テストを壊さない**(props も emit も変えていない)。

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
rtk proxy npx vitest run tests/pages/TimelinePage.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/pages/TimelinePage.vue"`

- [ ] **Step 3: 実装する**

`src/ui/TimelineView.vue` の `<script setup>` の先頭に足す:

```ts
defineOptions({ name: 'TimelineView' })
```

`src/pages/TimelinePage.vue`:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router'
import TimelineView from '../ui/TimelineView.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

function open(messageId: string): void {
  router.push({ name: 'message', params: { groupId: session.groupId, messageId } })
}
</script>

<template>
  <template v-if="session.session && session.storage">
    <button
      v-if="session.role !== 'member'"
      type="button"
      data-test="compose"
      @click="router.push({ name: 'compose', params: { groupId: session.groupId } })"
    >
      お知らせを作る
    </button>
    <button
      v-if="session.role !== 'member'"
      type="button"
      data-test="staff-panel"
      @click="router.push({ name: 'panel', params: { groupId: session.groupId } })"
    >
      受信と配布
    </button>
    <button
      v-if="session.role !== 'member'"
      type="button"
      data-test="absence-list"
      @click="router.push({ name: 'absences', params: { groupId: session.groupId } })"
    >
      届いた連絡
    </button>
    <!-- 不在連絡は全ロールが行える(要件書 §3) -->
    <button
      type="button"
      data-test="report"
      @click="router.push({ name: 'absence', params: { groupId: session.groupId } })"
    >
      れんらく
    </button>
    <TimelineView :session="session.session" :storage="session.storage" @open="open" />
  </template>
</template>
```

`src/pages/MessagePage.vue`:

```vue
<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import MessageDetailView from '../ui/MessageDetailView.vue'
import { useSessionStore } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
</script>

<template>
  <MessageDetailView
    v-if="session.session"
    :session="session.session"
    :message-id="String(route.params.messageId)"
    @back="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
```

`src/pages/ComposePage.vue`:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router'
import ComposeView from '../ui/ComposeView.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

function posted(messageId: string): void {
  router.push({ name: 'notify', params: { groupId: session.groupId, messageId } })
}
</script>

<template>
  <ComposeView
    v-if="session.session && session.storage"
    :session="session.session"
    :storage="session.storage"
    @posted="posted"
    @cancel="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
```

`src/pages/NotifyPage.vue`:

```vue
<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import NotifyView from '../ui/NotifyView.vue'
import { useSessionStore } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
</script>

<template>
  <NotifyView
    v-if="session.session && session.storage"
    :session="session.session"
    :storage="session.storage"
    :message-id="String(route.params.messageId)"
    @close="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
```

`src/pages/AbsencePage.vue`:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router'
import AbsenceView from '../ui/AbsenceView.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

function back(): void {
  router.push({ name: 'timeline', params: { groupId: session.groupId } })
}
</script>

<template>
  <AbsenceView
    v-if="session.session && session.storage"
    :session="session.session"
    :storage="session.storage"
    @sent="back"
    @cancel="back"
  />
</template>
```

`src/pages/AbsenceListPage.vue`:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router'
import AbsenceListView from '../ui/AbsenceListView.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()
</script>

<template>
  <AbsenceListView
    v-if="session.session"
    :session="session.session"
    @close="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
```

`src/pages/PanelPage.vue`:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router'
import StaffPanelView from '../ui/StaffPanelView.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()
</script>

<template>
  <StaffPanelView
    v-if="session.session && session.storage"
    :session="session.session"
    :storage="session.storage"
    :admin-public-key="session.adminPublicKey"
    @close="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
```

`src/pages/SetupPage.vue`:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router'
import SetupView from '../ui/SetupView.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

async function done(): Promise<void> {
  session.emailConfirmed = true
  await router.push({ name: 'timeline', params: { groupId: session.groupId } })
}
</script>

<template>
  <SetupView
    v-if="session.session && session.storage"
    :session="session.session"
    :storage="session.storage"
    @done="done"
  />
</template>
```

`src/App.vue` を丸ごと置き換える:

```vue
<script setup lang="ts">
// 画面の出し分けはルータが持つ。ここは器だけ。
</script>

<template>
  <main>
    <RouterView />
  </main>
</template>
```

`src/main.ts`:

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { createAppRouter } from './router'

createApp(App).use(createPinia()).use(createAppRouter()).mount('#app')
```

- [ ] **Step 4: 全体の検証**

```bash
rtk proxy npx vitest run && npm run typecheck && npm run build
```

Expected: すべて成功。既存の `tests/ui/*.test.ts` 10本も緑のまま。

- [ ] **Step 5: バンドルの増分を記録する**

```bash
npm run build 2>&1 | grep gzip
```

出力の gzip 値を、この計画の「完了条件」の下に追記する。

- [ ] **Step 6: コミット**

```bash
git add src/pages src/App.vue src/main.ts src/ui/TimelineView.vue tests/pages
git commit -m "feat(ui): drive every screen from the router"
```

---

## 完了条件

- `npm run test:run` が全て green。**3回連続で通ること**
- `npm run typecheck` がエラーなし
- `npm run build` が成功する
- **既存の `tests/ui/*.test.ts` 10本を1行も変更していない**(`git diff --stat master -- tests/ui` で確認)
- リロードでパスワード画面に戻り、解錠すると元の画面へ戻る
- 参加者が担当者用の URL を直接開いてもタイムラインへ戻される
- 未知のパスがトップへ送られる

## バンドル増分

導入前は単一チャンクで gzip 88.61 kB。導入後は初期読み込みが index 65.82 kB +
runtime-core 22.22 kB = **88.04 kB** で、画面ごとに遅延チャンクへ分かれた
(最大は ProvisionPage の 6.47 kB)。ルータとストアを足しても初期読み込みは
増えていない。開設ウィザードのような重い画面が初回に載らなくなったため。

## 次への引き継ぎ

- パスキー (WebAuthn PRF) と端末パスコードによる再認証の省力化。本計画の `unlock` がその差し込み口になる
- 入力途中の下書き保存(お知らせ作成・不在連絡)
- 画面デザインの適用 (`docs/design/Mofune Mobile.dc.html`)
- 複数グループの切り替え UI。URL とストアは対応済みだが、選ぶ画面が無い
