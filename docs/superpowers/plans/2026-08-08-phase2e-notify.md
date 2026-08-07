# Phase 2e: 受信の可視化とメール通知 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 担当者が届いた不在連絡を画面で読めるようにし、投稿したお知らせを `mailto:` の一括送信で知らせられるようにする。

**Architecture:** Phase 2d で不在連絡は `absences` テーブルまで届いているが、見る画面が無い。まずそこを閉じる。通知は関数層を持たないグループでも動く必要があるため、`mailto:` リンクを組み立てて担当者のメーラーを開く方式を基本とする(要件書 §4.5)。宛先は参加者間でアドレスを見せないよう **BCC** に入れ、URL 長の上限に当たらないようバッチに分割する。送信したかどうかは機械的に検証できないので、担当者の自己申告をローカルに記録する。

**Tech Stack:** Vue 3 / TypeScript / Vite / Vitest / Dexie.js / Web Crypto API

正は [要件書](../../Mofune%20-%20要件書.md) / [設計書](../../Mofune%20-%20設計書.md)。Phase 1〜2d の成果物の上に載る。

## Global Constraints

Phase 1〜2d の Global Constraints をすべて引き継ぐ。特に:

- 暗号プリミティブは Web Crypto API のみ。例外は Argon2id (hash-wasm) のみ
- **バイト列の型は `Bytes`**(= `Uint8Array<ArrayBuffer>`)。型注釈上の `Uint8Array` は `Bytes` と読み替え、テストの `as Uint8Array` も `as Bytes` にする
- **`noUnusedLocals` が有効。** 使わない import を残すとテストは通るのに型チェックだけ落ちる。各タスクで `npm run typecheck` まで通してからコミットする(Phase 2d で2回踏んだ)
- 秘密鍵・パスワード・ストレージ資格情報を IndexedDB / localStorage に保存してはならない
- **通知経路に本文・個人情報を載せてはならない**(要件書 §4.5 / §5.3)。件名と本文は「新着がある」ことだけを伝える
- **参加者間でメールアドレスを見せてはならない**(要件書 §4.6)。宛先は必ず BCC
- 既読情報を送出してはならない(要件書 §4.10)
- ストレージパスを組み立てる箇所は `assertSafePath` を通す
- **UI テストの待機は `vi.waitFor` で「実際に検証したい条件」を待つ。** 途中の状態を待つとフレーキーになる
- `tsconfig.json` は `strict: true` と `verbatimModuleSyntax: true`
- テストは `tests/**/*.test.ts`。`import { describe, it, expect } from 'vitest'` を明示する
- DOM が要るテストはファイル先頭に `// @vitest-environment happy-dom`
- コミットは Conventional Commits 形式。`Co-Authored-By` 行は付けない
- 実行時に外部CDNへ接続しない

## 既存インターフェース(実装前に確認済み)

```ts
// src/db/group-db.ts
interface CachedAbsence { id: string; kind: string; date: string; reason: string; note: string; author: string; at: string }
class GroupDatabase extends Dexie { messages; files; events; roster; outbox; syncState; absences }
// version(2) まで定義済み。テーブル追加には version(3) が要る
openGroupDatabase(groupId: string): GroupDatabase

// src/group/contacts.ts
interface Contact { email: string }
type ContactBook = Record<string, Contact>
readContacts(options: { file: RosterFile; staffKey: CryptoKey }): Promise<ContactBook>
sealContacts(options: { contacts: ContactBook; staffKey: CryptoKey; generation: number }): Promise<Bytes>
staffSectionKeyId(generation: number): string

// src/group/roster-update.ts
loadRosterFile(options: { storage: StorageProvider; groupId: string }): Promise<RosterFile>

// src/crypto/roster.ts
interface Subgroup { id: string; name: string; parent: string | null }
interface RosterMember { userId; displayName; role; scopes: string[]; ecdhPublic; ecdsaPublic }
interface RosterContents { groupId; generation; subgroups: Subgroup[]; members: RosterMember[] }
const ALL_SCOPE = 'all'; const STAFF_SCOPE = 'staff'

// src/crypto/envelope.ts
sealEnvelope(key: CryptoKey, keyId: string, plaintext: Bytes): Promise<Bytes>
openEnvelopeWithKey(key: CryptoKey, bytes: Bytes): Promise<Bytes>

// src/crypto/keyring.ts
keyId(scope: string, generation: number): string

// src/group/session.ts
interface Session { groupId; groupName; userId; displayName; role; scopes; groupKeys; roster; ecdhPrivate; ecdsaPrivate }

// src/content/absence.ts
type AbsenceKind = 'absent' | 'late' | 'early'
const ABSENCE_KINDS: readonly AbsenceKind[]
const DEFAULT_REASONS: readonly string[]

// src/content/post.ts
interface PostResult { messageId: string; eventId: string; attachments: AttachmentRef[] }
createPost(options: { session; db; draft; now? }): Promise<PostResult>

// src/storage/provider.ts
interface StorageProvider { capabilities; get; put; list(prefix, after?); delete }
```

## File Structure

```
src/ui/AbsenceListView.vue      届いた不在連絡の一覧 (担当者)              Task 1
src/group/group-settings.ts     settings/ の暗号化設定(テンプレ・通知)   Task 2
src/notify/recipients.ts        通知の受信者解決                            Task 3
src/notify/mailto.ts            mailto URL の組み立てとバッチ分割           Task 4
src/notify/delivery-log.ts      送信状況の記録(ローカル)                  Task 5
src/db/group-db.ts              deliveries テーブルを追加 (version 3)       Task 5
src/ui/NotifyView.vue           mailto 一括送信 (design 08)                 Task 5
src/App.vue                     画面遷移の配線(既存を変更)                Task 1, 5
```

---

### Task 1: 届いた不在連絡の一覧

**Files:**
- Create: `src/ui/AbsenceListView.vue`
- Modify: `src/App.vue`
- Test: `tests/ui/AbsenceListView.test.ts`

**Interfaces:**
- Consumes: `CachedAbsence` / `openGroupDatabase`、`Session`、`ABSENCE_KINDS`
- Produces: `AbsenceListView.vue`(props: `session: Session`。emit: `close`)

Phase 2d で `absences` テーブルまでは届いているが、見る画面が無い。ここを閉じないと 2d が動いていることを目で確認できない。

**参加者には見せない。** 他人の欠席理由が見えてしまう。担当者・管理者のときだけ開ける導線にする。

日付の新しい順に並べ、`author` は名簿から表示名に解決する。名簿に無い場合(退会済み等)は生の userId を出さず「不明」にする。

- [ ] **Step 1: 失敗するテストを書く**

`tests/ui/AbsenceListView.test.ts`:

```ts
// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import AbsenceListView from '../../src/ui/AbsenceListView.vue'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import type { CachedAbsence } from '../../src/db/group-db'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

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
      ecdhPublic: 'x',
      ecdsaPublic: 'x',
    },
  ],
}

function session(role: 'staff' | 'member' = 'staff'): Session {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role,
    scopes: ['all', 'staff'],
    groupKeys: new Map(),
    roster,
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
}

const older: CachedAbsence = {
  id: 'ab_old',
  kind: 'late',
  date: '2026-08-07',
  reason: '通院',
  note: '',
  author: 'u_sato',
  at: '2026-08-07T07:00:00.000Z',
}
const newer: CachedAbsence = {
  id: 'ab_new',
  kind: 'absent',
  date: '2026-08-08',
  reason: '体調不良',
  note: '朝から熱があります',
  author: 'u_sato',
  at: '2026-08-08T07:30:00.000Z',
}

let mounted: VueWrapper[] = []

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

async function mountList(role: 'staff' | 'member' = 'staff') {
  const wrapper = mount(AbsenceListView, { props: { session: session(role) } })
  mounted.push(wrapper)
  await vi.waitFor(() => {
    if (
      !wrapper.find('[data-test="ready"]').exists() &&
      !wrapper.find('[data-test="not-allowed"]').exists()
    ) {
      throw new Error('still loading')
    }
  }, { timeout: 2000, interval: 10 })
  return wrapper
}

describe('AbsenceListView', () => {
  it('shows an empty state when nothing has arrived', async () => {
    const wrapper = await mountList()
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true)
  })

  it('lists reports with the newest date first', async () => {
    await openGroupDatabase('midori').absences.bulkPut([older, newer])
    const wrapper = await mountList()
    const rows = wrapper.findAll('[data-test="absence"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('体調不良')
    expect(rows[1]?.text()).toContain('通院')
  })

  it('resolves the author to a display name', async () => {
    await openGroupDatabase('midori').absences.put(newer)
    const wrapper = await mountList()
    expect(wrapper.text()).toContain('佐藤 さくら')
    expect(wrapper.text()).not.toContain('u_sato')
  })

  it('falls back to a placeholder for an author who left the group', async () => {
    await openGroupDatabase('midori').absences.put({ ...newer, author: 'u_gone' })
    const wrapper = await mountList()
    expect(wrapper.text()).toContain('不明')
    expect(wrapper.text()).not.toContain('u_gone')
  })

  it('shows the kind in Japanese rather than the raw code', async () => {
    await openGroupDatabase('midori').absences.bulkPut([older, newer])
    const wrapper = await mountList()
    expect(wrapper.text()).toContain('欠席')
    expect(wrapper.text()).toContain('遅れます')
    expect(wrapper.text()).not.toContain('absent')
  })

  it('shows the free-text note when there is one', async () => {
    await openGroupDatabase('midori').absences.put(newer)
    const wrapper = await mountList()
    expect(wrapper.text()).toContain('朝から熱があります')
  })

  it('refuses to show anything to a member', async () => {
    await openGroupDatabase('midori').absences.put(newer)
    const wrapper = await mountList('member')
    expect(wrapper.find('[data-test="not-allowed"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="absence"]')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('体調不良')
  })

  it('emits close', async () => {
    const wrapper = await mountList()
    await wrapper.find('[data-test="close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/ui/AbsenceListView.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/ui/AbsenceListView.vue"`

- [ ] **Step 3: 実装する**

`src/ui/AbsenceListView.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { CachedAbsence } from '../db/group-db'
import { openGroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'

const props = defineProps<{ session: Session }>()
const emit = defineEmits<{ close: [] }>()

const KIND_LABELS: Record<string, string> = {
  absent: '欠席',
  late: '遅れます',
  early: '早く帰ります',
}

const absences = ref<CachedAbsence[]>([])
const loaded = ref(false)

// 参加者に見せると他人の欠席理由まで見えてしまう
const allowed = props.session.role !== 'member'

function authorName(userId: string): string {
  return (
    props.session.roster.members.find((member) => member.userId === userId)?.displayName ??
    '不明'
  )
}

onMounted(async () => {
  if (!allowed) {
    loaded.value = true
    return
  }
  try {
    const rows = await openGroupDatabase(props.session.groupId).absences.toArray()
    absences.value = rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  } catch {
    // DB が閉じられている場合は空のまま表示する
  } finally {
    loaded.value = true
  }
})
</script>

<template>
  <section v-if="loaded">
    <h1>届いた連絡</h1>
    <button type="button" data-test="close" @click="emit('close')">閉じる</button>

    <p v-if="!allowed" data-test="not-allowed">
      届いた連絡を見られるのは担当者と管理者だけです。
    </p>

    <div v-else data-test="ready">
      <p v-if="absences.length === 0" data-test="empty">まだ届いていません。</p>
      <ul v-else>
        <li v-for="absence in absences" :key="absence.id" data-test="absence">
          <p>{{ absence.date }}・{{ KIND_LABELS[absence.kind] ?? absence.kind }}</p>
          <p>{{ authorName(absence.author) }}</p>
          <p v-if="absence.reason">{{ absence.reason }}</p>
          <p v-if="absence.note">{{ absence.note }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>
```

`src/App.vue` に導線を足す。担当者・管理者にだけ出す。

```ts
const absenceListOpen = ref(false)
```

`v-else-if` の連鎖に入れる。

```vue
    <AbsenceListView
      v-else-if="absenceListOpen"
      :session="session"
      @close="absenceListOpen = false"
    />
```

タイムライン側のボタン群に足す。

```vue
      <button
        v-if="session.role !== 'member'"
        data-test="absence-list"
        @click="absenceListOpen = true"
      >
        届いた連絡
      </button>
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/ui/ && npm run typecheck
```

Expected: AbsenceListView 8 tests が green、既存の UI テストも green。

- [ ] **Step 5: コミット**

```bash
git add src/ui/AbsenceListView.vue src/App.vue tests/ui/AbsenceListView.test.ts
git commit -m "feat(ui): show absence reports that arrived through the inbox"
```

---

### Task 2: グループ設定(テンプレートと通知設定)

**Files:**
- Create: `src/group/group-settings.ts`
- Test: `tests/group/group-settings.test.ts`

**Interfaces:**
- Consumes: `Bytes` / `fromBase64` / `fromUtf8` / `utf8`、`sealEnvelope` / `openEnvelopeWithKey`、`keyId` / `STAFF_SCOPE`、`StorageProvider`、`NotFoundError`
- Produces: `class GroupSettingsError extends Error`、`interface MailTemplate { subject: string; body: string }`、`interface NotificationSettings { mutedScopes: string[]; channels: string[] }`、`interface GroupSettings { v: number; mailTemplate: MailTemplate; absenceReasons: string[]; notifications: NotificationSettings }`、`const DEFAULT_GROUP_SETTINGS`、`groupSettingsPath(groupId: string): string` / `readGroupSettings(options: { storage: StorageProvider; groupId: string; staffKey: CryptoKey }): Promise<GroupSettings>` / `writeGroupSettings(options: { storage: StorageProvider; groupId: string; settings: GroupSettings; staffKey: CryptoKey; generation: number }): Promise<void>` / `renderTemplate(template: string, values: Record<string, string>): string`

設計書 §9.2 / §9.4 の実装。`settings/templates.enc` に staff スコープで暗号化して置く。

**通知設定を manifest.json に置かない**(設計書 §9.2 の注記)。manifest は平文でログイン前に読むファイルであり、どのサブグループが通知を止めているかは第三者に見せる必要がない。

**設定が無いグループは既定値で動く。** 開設ウィザードは Phase 2f なので、それまでは `settings/templates.enc` が存在しない。`NotFoundError` を既定値で埋める。

`renderTemplate` のプレースホルダは `{{グループ名}}` `{{リンク}}` `{{種別}}` の3つに限る。**メッセージ本文を埋め込めるようにしてはならない**(平文経路に本文が載る)。未知のプレースホルダは置換せずそのまま残し、誤って中身が漏れるより「置換されていない」と分かる状態にする。

- [ ] **Step 1: 失敗するテストを書く**

`tests/group/group-settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_GROUP_SETTINGS,
  GroupSettingsError,
  groupSettingsPath,
  readGroupSettings,
  renderTemplate,
  writeGroupSettings,
} from '../../src/group/group-settings'
import type { GroupSettings } from '../../src/group/group-settings'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { utf8 } from '../../src/crypto/bytes'

const custom: GroupSettings = {
  v: 1,
  mailTemplate: {
    subject: '{{グループ名}}に新しいお知らせがあります',
    body: '{{グループ名}}からのお知らせです。\n{{リンク}}',
  },
  absenceReasons: ['体調不良', '通院'],
  notifications: { mutedScopes: ['sg_b'], channels: ['mailto'] },
}

describe('groupSettingsPath', () => {
  it('points at the encrypted settings object', () => {
    expect(groupSettingsPath('midori')).toBe('midori/settings/templates.enc')
  })
})

describe('DEFAULT_GROUP_SETTINGS', () => {
  it('has a subject and a body', () => {
    expect(DEFAULT_GROUP_SETTINGS.mailTemplate.subject.length).toBeGreaterThan(0)
    expect(DEFAULT_GROUP_SETTINGS.mailTemplate.body.length).toBeGreaterThan(0)
  })

  it('mutes nothing by default', () => {
    expect(DEFAULT_GROUP_SETTINGS.notifications.mutedScopes).toEqual([])
  })

  it('ships the common absence reasons', () => {
    expect(DEFAULT_GROUP_SETTINGS.absenceReasons).toContain('体調不良')
  })
})

describe('renderTemplate', () => {
  it('substitutes the allowed placeholders', () => {
    expect(
      renderTemplate('{{グループ名}}: {{種別}} {{リンク}}', {
        グループ名: 'みどり台グループ',
        種別: 'お知らせ',
        リンク: 'https://mofune.site/app/',
      }),
    ).toBe('みどり台グループ: お知らせ https://mofune.site/app/')
  })

  it('substitutes every occurrence', () => {
    expect(renderTemplate('{{リンク}} {{リンク}}', { リンク: 'x' })).toBe('x x')
  })

  it('leaves an unknown placeholder visible rather than guessing', () => {
    expect(renderTemplate('{{本文}}', { グループ名: 'g' })).toBe('{{本文}}')
  })

  it('does not touch text without placeholders', () => {
    expect(renderTemplate('新着があります', { グループ名: 'g' })).toBe('新着があります')
  })
})

describe('readGroupSettings / writeGroupSettings', () => {
  it('round-trips the settings', async () => {
    const storage = new MemoryStorageProvider()
    const staffKey = await generateAesKey()
    await writeGroupSettings({ storage, groupId: 'midori', settings: custom, staffKey, generation: 1 })
    expect(await readGroupSettings({ storage, groupId: 'midori', staffKey })).toEqual(custom)
  })

  it('falls back to the defaults when nothing has been written', async () => {
    const storage = new MemoryStorageProvider()
    const staffKey = await generateAesKey()
    expect(await readGroupSettings({ storage, groupId: 'midori', staffKey })).toEqual(
      DEFAULT_GROUP_SETTINGS,
    )
  })

  it('does not leave the template in plaintext on storage', async () => {
    const storage = new MemoryStorageProvider()
    const staffKey = await generateAesKey()
    await writeGroupSettings({ storage, groupId: 'midori', settings: custom, staffKey, generation: 1 })
    const raw = new TextDecoder().decode(await storage.get(groupSettingsPath('midori')))
    expect(raw).not.toContain('新しいお知らせ')
    expect(raw).not.toContain('sg_b')
  })

  it('cannot be read by someone without the staff key', async () => {
    const storage = new MemoryStorageProvider()
    await writeGroupSettings({
      storage,
      groupId: 'midori',
      settings: custom,
      staffKey: await generateAesKey(),
      generation: 1,
    })
    await expect(
      readGroupSettings({ storage, groupId: 'midori', staffKey: await generateAesKey() }),
    ).rejects.toThrow(GroupSettingsError)
  })

  it('reports settings that are not a settings object', async () => {
    const storage = new MemoryStorageProvider()
    const staffKey = await generateAesKey()
    const { sealEnvelope } = await import('../../src/crypto/envelope')
    await storage.put(
      groupSettingsPath('midori'),
      await sealEnvelope(staffKey, 'staff:v1', utf8('"nope"')),
    )
    await expect(readGroupSettings({ storage, groupId: 'midori', staffKey })).rejects.toThrow(
      GroupSettingsError,
    )
  })

  it('replaces the previous settings rather than accumulating', async () => {
    const storage = new MemoryStorageProvider()
    const staffKey = await generateAesKey()
    await writeGroupSettings({ storage, groupId: 'midori', settings: custom, staffKey, generation: 1 })
    await writeGroupSettings({
      storage,
      groupId: 'midori',
      settings: { ...custom, absenceReasons: ['家庭の都合'] },
      staffKey,
      generation: 1,
    })
    expect((await readGroupSettings({ storage, groupId: 'midori', staffKey })).absenceReasons).toEqual([
      '家庭の都合',
    ])
    expect(await storage.list('midori/settings/')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/group/group-settings.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/group/group-settings"`

- [ ] **Step 3: 実装する**

`src/group/group-settings.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import { fromUtf8, utf8 } from '../crypto/bytes'
import { openEnvelopeWithKey, sealEnvelope } from '../crypto/envelope'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import type { StorageProvider } from '../storage/provider'

export class GroupSettingsError extends Error {}

export const GROUP_SETTINGS_VERSION = 1

export interface MailTemplate {
  subject: string
  body: string
}

export interface NotificationSettings {
  /** 通知を止めているスコープ id。 */
  mutedScopes: string[]
  /** 既定で使うチャネル。今フェーズで実装があるのは 'mailto' のみ。 */
  channels: string[]
}

export interface GroupSettings {
  v: number
  mailTemplate: MailTemplate
  absenceReasons: string[]
  notifications: NotificationSettings
}

/**
 * 通知経路は平文なので、本文を載せられるプレースホルダを用意しない
 * (要件書 §4.5)。件名・本文は「新着がある」ことだけを伝える。
 */
export const DEFAULT_GROUP_SETTINGS: GroupSettings = {
  v: GROUP_SETTINGS_VERSION,
  mailTemplate: {
    subject: '{{グループ名}}に新着があります',
    body: '{{グループ名}}に新しい{{種別}}が届いています。\n\n{{リンク}}\n\nこのメールに本文は含まれません。アプリを開いてご確認ください。',
  },
  absenceReasons: ['体調不良', '通院', '家庭の都合'],
  notifications: { mutedScopes: [], channels: ['mailto'] },
}

export function groupSettingsPath(groupId: string): string {
  return `${groupId}/settings/templates.enc`
}

/** 許すプレースホルダはこの3つだけ。本文を差し込めるものを増やしてはならない。 */
const ALLOWED_PLACEHOLDERS = ['グループ名', 'リンク', '種別']

/**
 * 未知のプレースホルダは置換せずそのまま残す。
 * 黙って空文字にすると、意図せず中身が抜けたことに気づけない。
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  let out = template
  for (const name of ALLOWED_PLACEHOLDERS) {
    const value = values[name]
    if (value === undefined) continue
    out = out.split(`{{${name}}}`).join(value)
  }
  return out
}

export async function writeGroupSettings(options: {
  storage: StorageProvider
  groupId: string
  settings: GroupSettings
  staffKey: CryptoKey
  generation: number
}): Promise<void> {
  const sealed = await sealEnvelope(
    options.staffKey,
    keyId(STAFF_SCOPE, options.generation),
    utf8(JSON.stringify(options.settings)),
  )
  await options.storage.put(groupSettingsPath(options.groupId), sealed)
}

/** 未設定のグループは既定値で動く。開設ウィザードは Phase 2f のため。 */
export async function readGroupSettings(options: {
  storage: StorageProvider
  groupId: string
  staffKey: CryptoKey
}): Promise<GroupSettings> {
  let sealed: Bytes
  try {
    sealed = await options.storage.get(groupSettingsPath(options.groupId))
  } catch {
    return DEFAULT_GROUP_SETTINGS
  }

  let plaintext: Bytes
  try {
    plaintext = await openEnvelopeWithKey(options.staffKey, sealed)
  } catch {
    throw new GroupSettingsError('group settings could not be decrypted with this key')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(plaintext))
  } catch {
    throw new GroupSettingsError('group settings are not valid JSON')
  }
  const settings = parsed as GroupSettings
  if (
    settings === null ||
    typeof settings !== 'object' ||
    settings.mailTemplate === null ||
    typeof settings.mailTemplate !== 'object' ||
    !Array.isArray(settings.absenceReasons) ||
    settings.notifications === null ||
    typeof settings.notifications !== 'object'
  ) {
    throw new GroupSettingsError('group settings are missing required fields')
  }
  return settings
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/group/group-settings.test.ts && npm run typecheck
```

Expected: 14 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/group/group-settings.ts tests/group/group-settings.test.ts
git commit -m "feat(group): store mail templates and notification settings under the staff scope"
```

---
### Task 3: 通知の受信者解決

**Files:**
- Create: `src/notify/recipients.ts`
- Test: `tests/notify/recipients.test.ts`

**Interfaces:**
- Consumes: Task 2 の `NotificationSettings`、`ContactBook`、`RosterContents` / `RosterMember`
- Produces: `interface Recipient { userId: string; displayName: string; email: string }`、`interface Audience { reachable: Recipient[]; missingEmail: string[]; muted: string[] }`、`resolveAudience(options: { roster: RosterContents; contacts: ContactBook; settings: NotificationSettings; scopes: string[]; excludeUserId?: string }): Audience`

設計書 §9.2 の「スコープのメンバー ∩ サブグループ通知が有効 ∩ 個人設定が有効」を1つの純関数にする。

**メールアドレスが無い人を黙って落とさない。** `missingEmail` に userId を積んで返し、画面で「メール未登録 3名」と出せるようにする(design 08)。落としたまま何も言わないと、届いていないことに担当者が気づけない。

**投稿者自身は除く。** 自分の投稿の通知が自分に来ると邪魔になる。`excludeUserId` で指定する。

**通知を止めているスコープ宛の配信は、その分だけ受信者から外す。** ただし複数スコープ宛の投稿で片方が有効なら、その人には届く(所属が重なっている場合)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/notify/recipients.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveAudience } from '../../src/notify/recipients'
import type { ContactBook } from '../../src/group/contacts'
import type { NotificationSettings } from '../../src/group/group-settings'
import type { RosterContents } from '../../src/crypto/roster'

const roster: RosterContents = {
  groupId: 'midori',
  generation: 1,
  subgroups: [
    { id: 'sg_a', name: 'Aチーム', parent: null },
    { id: 'sg_b', name: 'Bチーム', parent: null },
  ],
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
      userId: 'u_mori',
      displayName: '森 ゆい',
      role: 'member',
      scopes: ['all', 'sg_b'],
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

const contacts: ContactBook = {
  u_tanaka: { email: 'tanaka@example.com' },
  u_sato: { email: 'sakura@example.com' },
  u_mori: { email: 'yui@example.com' },
  // u_new はまだ登録していない
}

const settings: NotificationSettings = { mutedScopes: [], channels: ['mailto'] }

describe('resolveAudience', () => {
  it('reaches everyone in the addressed scope', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['sg_a'] })
    expect(audience.reachable.map((r) => r.userId).sort()).toEqual(['u_sato', 'u_tanaka'])
  })

  it('carries the display name and the address', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['sg_a'] })
    const sato = audience.reachable.find((r) => r.userId === 'u_sato')
    expect(sato?.displayName).toBe('佐藤 さくら')
    expect(sato?.email).toBe('sakura@example.com')
  })

  it('does not reach someone outside the addressed scope', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['sg_a'] })
    expect(audience.reachable.map((r) => r.userId)).not.toContain('u_mori')
  })

  it('reports members with no address instead of dropping them silently', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['sg_a'] })
    expect(audience.missingEmail).toEqual(['u_new'])
    expect(audience.reachable.map((r) => r.userId)).not.toContain('u_new')
  })

  it('excludes the author', () => {
    const audience = resolveAudience({
      roster,
      contacts,
      settings,
      scopes: ['sg_a'],
      excludeUserId: 'u_tanaka',
    })
    expect(audience.reachable.map((r) => r.userId)).toEqual(['u_sato'])
  })

  it('does not report the author as missing an address', () => {
    const audience = resolveAudience({
      roster,
      contacts,
      settings,
      scopes: ['sg_a'],
      excludeUserId: 'u_new',
    })
    expect(audience.missingEmail).toEqual([])
  })

  it('drops a scope that is muted', () => {
    const muted: NotificationSettings = { mutedScopes: ['sg_a'], channels: ['mailto'] }
    const audience = resolveAudience({ roster, contacts, settings: muted, scopes: ['sg_a'] })
    expect(audience.reachable).toEqual([])
    expect(audience.muted).toEqual(['sg_a'])
  })

  it('still reaches people through a scope that is not muted', () => {
    const muted: NotificationSettings = { mutedScopes: ['sg_a'], channels: ['mailto'] }
    const audience = resolveAudience({
      roster,
      contacts,
      settings: muted,
      scopes: ['sg_a', 'sg_b'],
    })
    expect(audience.reachable.map((r) => r.userId)).toEqual(['u_mori'])
    expect(audience.muted).toEqual(['sg_a'])
  })

  it('does not repeat someone who is in two addressed scopes', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['all', 'sg_a'] })
    const ids = audience.reachable.map((r) => r.userId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reaches the whole group through the all scope', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['all'] })
    expect(audience.reachable.map((r) => r.userId).sort()).toEqual([
      'u_mori',
      'u_sato',
      'u_tanaka',
    ])
  })

  it('returns nothing for a scope nobody belongs to', () => {
    const audience = resolveAudience({ roster, contacts, settings, scopes: ['sg_zzz'] })
    expect(audience).toEqual({ reachable: [], missingEmail: [], muted: [] })
  })

  it('treats an empty address as missing', () => {
    const audience = resolveAudience({
      roster,
      contacts: { ...contacts, u_new: { email: '   ' } },
      settings,
      scopes: ['sg_a'],
    })
    expect(audience.missingEmail).toEqual(['u_new'])
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/notify/recipients.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/notify/recipients"`

- [ ] **Step 3: 実装する**

`src/notify/recipients.ts`:

```ts
import type { RosterContents } from '../crypto/roster'
import type { ContactBook } from '../group/contacts'
import type { NotificationSettings } from '../group/group-settings'

export interface Recipient {
  userId: string
  displayName: string
  email: string
}

export interface Audience {
  reachable: Recipient[]
  /** メールアドレスが未登録の userId。黙って落とさず担当者に見せる。 */
  missingEmail: string[]
  /** 通知が止まっていたため配信対象から外したスコープ。 */
  muted: string[]
}

/**
 * 「スコープのメンバー ∩ サブグループ通知が有効 ∩ 個人設定が有効」を解決する
 * (設計書 §9.2)。純関数にしておき、画面からもテストからも同じ結果を得る。
 */
export function resolveAudience(options: {
  roster: RosterContents
  contacts: ContactBook
  settings: NotificationSettings
  scopes: string[]
  excludeUserId?: string
}): Audience {
  const muted = options.scopes.filter((scope) =>
    options.settings.mutedScopes.includes(scope),
  )
  const active = options.scopes.filter((scope) => !muted.includes(scope))

  const reachable: Recipient[] = []
  const missingEmail: string[] = []

  for (const member of options.roster.members) {
    if (member.userId === options.excludeUserId) continue
    if (!member.scopes.some((scope) => active.includes(scope))) continue

    const email = options.contacts[member.userId]?.email?.trim() ?? ''
    if (email.length === 0) {
      missingEmail.push(member.userId)
      continue
    }
    reachable.push({
      userId: member.userId,
      displayName: member.displayName,
      email,
    })
  }

  return { reachable, missingEmail, muted }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/notify/recipients.test.ts && npm run typecheck
```

Expected: 12 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/notify/recipients.ts tests/notify/recipients.test.ts
git commit -m "feat(notify): resolve the audience for a post"
```

---

### Task 4: mailto URL の組み立てとバッチ分割

**Files:**
- Create: `src/notify/mailto.ts`
- Test: `tests/notify/mailto.test.ts`

**Interfaces:**
- Consumes: Task 2 の `MailTemplate` / `renderTemplate`、Task 3 の `Recipient`
- Produces: `class MailtoError extends Error`、`const DEFAULT_MAX_URL_LENGTH` / `const MIN_BATCH_SIZE`、`interface MailBatch { index: number; total: number; url: string; recipients: Recipient[] }`、`buildMailtoUrl(options: { to: string; bcc: string[]; subject: string; body: string }): string` / `buildMailBatches(options: { recipients: Recipient[]; template: MailTemplate; groupName: string; kind: string; link: string; to: string; maxUrlLength?: number }): MailBatch[]`

要件書 §4.5 と設計書 §9.4 の実装。

**宛先は必ず BCC に入れる。** TO に入れると参加者どうしにアドレスが見えてしまう(要件書 §4.6)。TO にはグループの共用アドレスを入れる。

**URL 長の上限に当たる前に分割する。** 上限はメーラーと OS に依存し、**本計画作成時点で実機検証(検証課題 §16-1)は未了である。** そのため `DEFAULT_MAX_URL_LENGTH` は保守的な値にし、呼び出し側から差し替えられるようにする。**この定数を「検証済みの正しい値」として扱ってはならない。** 実機で確かめたら、この定数と §16-1 を同時に更新する。

1バッチの人数が `MIN_BATCH_SIZE` を下回るような長さ指定は、分割しても収まらないということなので `MailtoError` にする。無限に分割し続けるより、設定が悪いと伝えるほうがよい。

- [ ] **Step 1: 失敗するテストを書く**

`tests/notify/mailto.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MAX_URL_LENGTH,
  MailtoError,
  buildMailBatches,
  buildMailtoUrl,
} from '../../src/notify/mailto'
import type { Recipient } from '../../src/notify/recipients'
import type { MailTemplate } from '../../src/group/group-settings'

const template: MailTemplate = {
  subject: '{{グループ名}}に新着があります',
  body: '{{グループ名}}に新しい{{種別}}が届いています。\n{{リンク}}',
}

function people(count: number): Recipient[] {
  return Array.from({ length: count }, (_, i) => ({
    userId: `u_${i}`,
    displayName: `参加者${i}`,
    email: `member${String(i).padStart(3, '0')}@example.com`,
  }))
}

const base = {
  template,
  groupName: 'みどり台グループ',
  kind: 'お知らせ',
  link: 'https://mofune.site/app/',
  to: 'group@example.com',
}

describe('buildMailtoUrl', () => {
  it('starts with the mailto scheme and the to address', () => {
    const url = buildMailtoUrl({ to: 'group@example.com', bcc: [], subject: 's', body: 'b' })
    expect(url.startsWith('mailto:group@example.com?')).toBe(true)
  })

  it('puts every recipient in bcc, never in to', () => {
    const url = buildMailtoUrl({
      to: 'group@example.com',
      bcc: ['a@example.com', 'b@example.com'],
      subject: 's',
      body: 'b',
    })
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect(params.get('bcc')).toBe('a@example.com,b@example.com')
    expect(url.slice(0, url.indexOf('?'))).toBe('mailto:group@example.com')
  })

  it('percent-encodes the subject and body', () => {
    const url = buildMailtoUrl({
      to: 'g@example.com',
      bcc: [],
      subject: 'みどり台 & 新着',
      body: '1行目\n2行目',
    })
    expect(url).not.toContain('みどり台')
    expect(url).not.toContain('\n')
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect(params.get('subject')).toBe('みどり台 & 新着')
    expect(params.get('body')).toBe('1行目\n2行目')
  })

  it('omits bcc when there is nobody to address', () => {
    const url = buildMailtoUrl({ to: 'g@example.com', bcc: [], subject: 's', body: 'b' })
    expect(url).not.toContain('bcc=')
  })
})

describe('buildMailBatches', () => {
  it('produces a single batch for a small group', () => {
    const batches = buildMailBatches({ ...base, recipients: people(5) })
    expect(batches).toHaveLength(1)
    expect(batches[0]?.recipients).toHaveLength(5)
    expect(batches[0]).toMatchObject({ index: 1, total: 1 })
  })

  it('renders the template into the subject and body', () => {
    const batches = buildMailBatches({ ...base, recipients: people(1) })
    const params = new URLSearchParams(batches[0]?.url.split('?')[1] ?? '')
    expect(params.get('subject')).toBe('みどり台グループに新着があります')
    expect(params.get('body')).toContain('新しいお知らせが届いています')
    expect(params.get('body')).toContain('https://mofune.site/app/')
  })

  it('splits when the url would be too long', () => {
    const batches = buildMailBatches({ ...base, recipients: people(200), maxUrlLength: 800 })
    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) {
      expect(batch.url.length).toBeLessThanOrEqual(800)
    }
  })

  it('numbers the batches for the ui', () => {
    const batches = buildMailBatches({ ...base, recipients: people(200), maxUrlLength: 800 })
    expect(batches.map((b) => b.index)).toEqual(batches.map((_, i) => i + 1))
    for (const batch of batches) expect(batch.total).toBe(batches.length)
  })

  it('includes every recipient exactly once across the batches', () => {
    const recipients = people(200)
    const batches = buildMailBatches({ ...base, recipients, maxUrlLength: 800 })
    const addressed = batches.flatMap((b) => b.recipients.map((r) => r.userId))
    expect(addressed.sort()).toEqual(recipients.map((r) => r.userId).sort())
  })

  it('never puts an address in the to field', () => {
    const batches = buildMailBatches({ ...base, recipients: people(50), maxUrlLength: 900 })
    for (const batch of batches) {
      expect(batch.url.slice(0, batch.url.indexOf('?'))).toBe('mailto:group@example.com')
    }
  })

  it('returns nothing when there is nobody to notify', () => {
    expect(buildMailBatches({ ...base, recipients: [] })).toEqual([])
  })

  it('refuses a url budget too small to fit even a few addresses', () => {
    expect(() =>
      buildMailBatches({ ...base, recipients: people(10), maxUrlLength: 50 }),
    ).toThrow(MailtoError)
  })

  it('has a conservative default budget', () => {
    // 実機未検証の値。検証課題 §16-1 が終わるまで「正しい」とみなさない
    expect(DEFAULT_MAX_URL_LENGTH).toBeGreaterThan(0)
    expect(DEFAULT_MAX_URL_LENGTH).toBeLessThanOrEqual(2000)
  })

  it('does not put the message body into the mail', () => {
    const batches = buildMailBatches({
      ...base,
      recipients: people(1),
      template: { subject: '{{グループ名}}', body: '{{本文}}' },
    })
    const params = new URLSearchParams(batches[0]?.url.split('?')[1] ?? '')
    // 未知のプレースホルダは置換されず、そのまま残る
    expect(params.get('body')).toBe('{{本文}}')
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/notify/mailto.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/notify/mailto"`

- [ ] **Step 3: 実装する**

`src/notify/mailto.ts`:

```ts
import type { MailTemplate } from '../group/group-settings'
import { renderTemplate } from '../group/group-settings'
import type { Recipient } from './recipients'

export class MailtoError extends Error {}

/**
 * mailto: URL の長さの上限(保守的な既定値)。
 *
 * 実際の上限はメーラーと OS に依存し、**実機検証 (検証課題 §16-1) は未了である。**
 * この値を「検証済みの正しい値」として扱わないこと。実機で確かめたら、
 * この定数と §16-1 を同時に更新する。
 */
export const DEFAULT_MAX_URL_LENGTH = 1800

/** これを下回る分割しかできないなら、設定が現実的でない。 */
export const MIN_BATCH_SIZE = 2

export interface MailBatch {
  /** 1 始まり。画面に「(1/3)」と出すため。 */
  index: number
  total: number
  url: string
  recipients: Recipient[]
}

export function buildMailtoUrl(options: {
  to: string
  bcc: string[]
  subject: string
  body: string
}): string {
  const params = new URLSearchParams()
  // 参加者どうしにアドレスを見せないため、宛先は必ず BCC に入れる
  if (options.bcc.length > 0) params.set('bcc', options.bcc.join(','))
  params.set('subject', options.subject)
  params.set('body', options.body)
  return `mailto:${options.to}?${params.toString()}`
}

export function buildMailBatches(options: {
  recipients: Recipient[]
  template: MailTemplate
  groupName: string
  kind: string
  link: string
  to: string
  maxUrlLength?: number
}): MailBatch[] {
  if (options.recipients.length === 0) return []

  const budget = options.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH
  const values = {
    グループ名: options.groupName,
    種別: options.kind,
    リンク: options.link,
  }
  const subject = renderTemplate(options.template.subject, values)
  const body = renderTemplate(options.template.body, values)

  const build = (group: Recipient[]): string =>
    buildMailtoUrl({
      to: options.to,
      bcc: group.map((recipient) => recipient.email),
      subject,
      body,
    })

  const groups: Recipient[][] = []
  let current: Recipient[] = []
  for (const recipient of options.recipients) {
    const candidate = [...current, recipient]
    if (current.length > 0 && build(candidate).length > budget) {
      groups.push(current)
      current = [recipient]
      continue
    }
    current = candidate
  }
  if (current.length > 0) groups.push(current)

  // 1人ぶんでも収まらないなら、これ以上分割しても意味がない
  const tooTight = groups.some(
    (group) => group.length < MIN_BATCH_SIZE && build(group).length > budget,
  )
  if (tooTight) {
    throw new MailtoError(
      `maxUrlLength ${budget} is too small to address even ${MIN_BATCH_SIZE} recipients`,
    )
  }

  return groups.map((group, index) => ({
    index: index + 1,
    total: groups.length,
    url: build(group),
    recipients: group,
  }))
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/notify/mailto.test.ts && npm run typecheck
```

Expected: 14 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/notify/mailto.ts tests/notify/mailto.test.ts
git commit -m "feat(notify): build bcc mailto batches that fit the url budget"
```

---

### Task 5: 送信状況の記録と一括送信画面

**Files:**
- Create: `src/notify/delivery-log.ts`
- Modify: `src/db/group-db.ts`(`deliveries` テーブルを追加。Dexie を version 3 へ)
- Create: `src/ui/NotifyView.vue`
- Modify: `src/App.vue`
- Test: `tests/notify/delivery-log.test.ts`
- Test: `tests/ui/NotifyView.test.ts`

**Interfaces:**
- Consumes: Task 2 の `readGroupSettings`、Task 3 の `resolveAudience`、Task 4 の `buildMailBatches` / `MailBatch`、`readContacts` / `loadRosterFile`、`Session`、`StorageProvider`、`openGroupDatabase`
- Produces: `interface DeliveryRecord { id: string; messageId: string; batchIndex: number; total: number; recipients: number; sentAt: string | null }`、`GroupDatabase.deliveries: Table<DeliveryRecord, string>`、`recordBatches(options: { db; messageId: string; batches: MailBatch[] }): Promise<void>` / `markBatchSent(options: { db; messageId: string; batchIndex: number; now?: Date }): Promise<void>` / `pendingBatches(db, messageId?): Promise<DeliveryRecord[]>`、`NotifyView.vue`(props: `session`、`storage`、`messageId: string`。emit: `close`)

**送信したかどうかは機械的に検証できない**(要件書 §6-2)。`mailto:` はメーラーを開くだけで、送ったかどうかはアプリから見えない。担当者が「送った」を押した自己申告をローカルに記録し、未送信のバッチを画面に残す。

**Dexie を version 3 に上げる。** version(1) と version(2) の定義は消さない。

画面はバッチごとにリンクを並べ、押すとメーラーが開き、隣のチェックで送信済みにする。メール未登録の人数も出す(design 08 の「メール未登録 3名」)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/notify/delivery-log.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { markBatchSent, pendingBatches, recordBatches } from '../../src/notify/delivery-log'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import type { MailBatch } from '../../src/notify/mailto'

const batches: MailBatch[] = [
  { index: 1, total: 2, url: 'mailto:a', recipients: [] },
  { index: 2, total: 2, url: 'mailto:b', recipients: [] },
]

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('delivery log', () => {
  it('records every batch as unsent', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    const pending = await pendingBatches(db, 'm_1')
    expect(pending).toHaveLength(2)
    expect(pending.every((record) => record.sentAt === null)).toBe(true)
  })

  it('marks one batch as sent without touching the other', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    await markBatchSent({ db, messageId: 'm_1', batchIndex: 1 })
    const pending = await pendingBatches(db, 'm_1')
    expect(pending.map((record) => record.batchIndex)).toEqual([2])
  })

  it('records when the batch was said to be sent', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    await markBatchSent({ db, messageId: 'm_1', batchIndex: 1, now: new Date('2026-08-08T10:00:00.000Z') })
    const all = await db.deliveries.toArray()
    const sent = all.find((record) => record.batchIndex === 1)
    expect(sent?.sentAt).toBe('2026-08-08T10:00:00.000Z')
  })

  it('reports nothing pending once every batch is sent', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    await markBatchSent({ db, messageId: 'm_1', batchIndex: 1 })
    await markBatchSent({ db, messageId: 'm_1', batchIndex: 2 })
    expect(await pendingBatches(db, 'm_1')).toHaveLength(0)
  })

  it('keeps different messages apart', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    await recordBatches({ db, messageId: 'm_2', batches })
    await markBatchSent({ db, messageId: 'm_1', batchIndex: 1 })
    expect(await pendingBatches(db, 'm_1')).toHaveLength(1)
    expect(await pendingBatches(db, 'm_2')).toHaveLength(2)
  })

  it('lists everything still unsent across messages', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    await recordBatches({ db, messageId: 'm_2', batches })
    expect(await pendingBatches(db)).toHaveLength(4)
  })

  it('does not duplicate when the same batches are recorded twice', async () => {
    const db = openGroupDatabase('midori')
    await recordBatches({ db, messageId: 'm_1', batches })
    await recordBatches({ db, messageId: 'm_1', batches })
    expect(await db.deliveries.count()).toBe(2)
  })

  it('ignores marking a batch that was never recorded', async () => {
    const db = openGroupDatabase('midori')
    await markBatchSent({ db, messageId: 'm_zzz', batchIndex: 1 })
    expect(await db.deliveries.count()).toBe(0)
  })
})
```

`tests/ui/NotifyView.test.ts`:

```ts
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
import { signRoster, serializeRosterFile } from '../../src/crypto/roster'
import { generateEcdsaKeyPair } from '../../src/crypto/asymmetric'
import { generateAesKey } from '../../src/crypto/symmetric'
import { rosterPath } from '../../src/storage/paths'
import { MemoryStorageProvider } from '../../src/storage/memory'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

async function fixture(options: { withAddresses?: boolean } = {}) {
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
  const contacts = options.withAddresses === false ? {} : { u_sato: { email: 'sakura@example.com' } }
  const storage = new MemoryStorageProvider()
  const staffSection = await sealContacts({ contacts, staffKey, generation: 1 })
  const file = await signRoster(roster, staffSection, admin)
  await storage.put(rosterPath('midori'), serializeRosterFile(file))
  await writeGroupSettings({
    storage,
    groupId: 'midori',
    settings: DEFAULT_GROUP_SETTINGS,
    staffKey,
    generation: 1,
  })

  const session: Session = {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role: 'staff',
    scopes: ['all', 'staff', 'sg_a'],
    groupKeys: new Map([['staff:v1', staffKey]]),
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

async function mountNotify(options: { withAddresses?: boolean } = {}) {
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/notify/delivery-log.test.ts tests/ui/NotifyView.test.ts
```

Expected: FAIL — 両方のモジュールが解決できない。

- [ ] **Step 3: 実装する**

`src/db/group-db.ts` にテーブルを足す。

```ts
export interface DeliveryRecord {
  /** `${messageId}#${batchIndex}` */
  id: string
  messageId: string
  batchIndex: number
  total: number
  recipients: number
  /** 担当者が「送った」と申告した時刻。未送信は null。 */
  sentAt: string | null
}
```

`GroupDatabase` にフィールドを足す。

```ts
  deliveries!: Table<DeliveryRecord, string>
```

コンストラクタに version(3) を足す(**version(1) と version(2) は残す**)。

```ts
    this.version(3).stores({
      messages: 'id, at',
      files: 'id, cachedAt',
      events: 'id',
      roster: 'groupId',
      outbox: 'id, queuedAt',
      syncState: 'key',
      absences: 'id, date',
      deliveries: 'id, messageId',
    })
```

`src/notify/delivery-log.ts`:

```ts
import type { DeliveryRecord, GroupDatabase } from '../db/group-db'
import type { MailBatch } from './mailto'

function recordId(messageId: string, batchIndex: number): string {
  return `${messageId}#${batchIndex}`
}

export async function recordBatches(options: {
  db: GroupDatabase
  messageId: string
  batches: MailBatch[]
}): Promise<void> {
  for (const batch of options.batches) {
    const id = recordId(options.messageId, batch.index)
    // 既に記録済みなら送信状況を上書きしない
    if (await options.db.deliveries.get(id)) continue
    const record: DeliveryRecord = {
      id,
      messageId: options.messageId,
      batchIndex: batch.index,
      total: batch.total,
      recipients: batch.recipients.length,
      sentAt: null,
    }
    await options.db.deliveries.put(record)
  }
}

/**
 * 送信したかどうかは機械的に検証できない(要件書 §6-2)。
 * mailto: はメーラーを開くだけなので、担当者の自己申告を記録する。
 */
export async function markBatchSent(options: {
  db: GroupDatabase
  messageId: string
  batchIndex: number
  now?: Date
}): Promise<void> {
  const id = recordId(options.messageId, options.batchIndex)
  const record = await options.db.deliveries.get(id)
  if (!record) return
  await options.db.deliveries.put({
    ...record,
    sentAt: (options.now ?? new Date()).toISOString(),
  })
}

export async function pendingBatches(
  db: GroupDatabase,
  messageId?: string,
): Promise<DeliveryRecord[]> {
  const all = await db.deliveries.toArray()
  return all
    .filter((record) => record.sentAt === null)
    .filter((record) => messageId === undefined || record.messageId === messageId)
    .sort((a, b) => a.batchIndex - b.batchIndex)
}
```

`src/ui/NotifyView.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import { openGroupDatabase } from '../db/group-db'
import { readContacts } from '../group/contacts'
import { readGroupSettings } from '../group/group-settings'
import { loadRosterFile } from '../group/roster-update'
import type { Session } from '../group/session'
import { buildMailBatches } from '../notify/mailto'
import type { MailBatch } from '../notify/mailto'
import { markBatchSent, recordBatches } from '../notify/delivery-log'
import { resolveAudience } from '../notify/recipients'
import type { StorageProvider } from '../storage/provider'

const props = defineProps<{
  session: Session
  storage: StorageProvider
  messageId: string
}>()
const emit = defineEmits<{ close: [] }>()

const batches = ref<MailBatch[]>([])
const missingEmail = ref<string[]>([])
const sent = ref<Record<number, boolean>>({})
const error = ref('')
const loaded = ref(false)

const db = openGroupDatabase(props.session.groupId)

onMounted(async () => {
  try {
    const staffKey = props.session.groupKeys.get(keyId(STAFF_SCOPE, 1))
    if (!staffKey) throw new Error('staff スコープ鍵がありません')

    const [file, settings, message] = await Promise.all([
      loadRosterFile({ storage: props.storage, groupId: props.session.groupId }),
      readGroupSettings({
        storage: props.storage,
        groupId: props.session.groupId,
        staffKey,
      }),
      db.messages.get(props.messageId),
    ])
    const contacts = await readContacts({ file, staffKey })

    const audience = resolveAudience({
      roster: props.session.roster,
      contacts,
      settings: settings.notifications,
      scopes: message?.scopes ?? [],
      excludeUserId: props.session.userId,
    })
    missingEmail.value = audience.missingEmail

    batches.value = buildMailBatches({
      recipients: audience.reachable,
      template: settings.mailTemplate,
      groupName: props.session.groupName,
      kind: 'お知らせ',
      link: `${location.origin}/app/`,
      to: '',
    })
    await recordBatches({ db, messageId: props.messageId, batches: batches.value })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '通知を組み立てられませんでした'
  } finally {
    loaded.value = true
  }
})

async function markSent(batch: MailBatch): Promise<void> {
  sent.value = { ...sent.value, [batch.index]: true }
  await markBatchSent({ db, messageId: props.messageId, batchIndex: batch.index })
}
</script>

<template>
  <section v-if="loaded" data-test="ready">
    <h1>メールで知らせる</h1>
    <button type="button" data-test="close" @click="emit('close')">閉じる</button>

    <p>
      リンクを押すとメールアプリが開きます。送信そのものはアプリからは
      <strong>自動では確認できません</strong>ので、送り終えたら「送った」を押してください。
    </p>
    <p>宛先は BCC に入っています。参加者どうしにアドレスは見えません。</p>

    <p v-if="error" data-test="error">{{ error }}</p>

    <p v-if="missingEmail.length > 0" data-test="missing-email">
      メール未登録 {{ missingEmail.length }} 名。この方々には届きません。
    </p>

    <p v-if="batches.length === 0" data-test="nobody">
      メールで知らせられる相手がいません。
    </p>

    <ul v-else>
      <li v-for="batch in batches" :key="batch.index">
        <a data-test="batch-link" :href="batch.url">
          メールを開く ({{ batch.index }}/{{ batch.total }}) · {{ batch.recipients.length }} 名
        </a>
        <button
          type="button"
          data-test="mark-sent"
          :disabled="sent[batch.index] === true"
          @click="markSent(batch)"
        >
          送った
        </button>
      </li>
    </ul>
  </section>
</template>
```

`src/App.vue` に配線する。投稿直後に開けるよう、`ComposeView` の `posted` を受けて `notifyMessageId` に入れる。

```ts
const notifyMessageId = ref<string | null>(null)
```

`ComposeView` は現在 `posted` を引数なしで emit している。投稿した messageId を渡すよう `src/ui/ComposeView.vue` を変更する。

```ts
const emit = defineEmits<{ posted: [messageId: string]; cancel: [] }>()
```

`createPost` の戻り値を受けて `emit('posted', result.messageId)` にする。既存の `tests/ui/ComposeView.test.ts` は `emitted('posted')` の有無しか見ていないのでそのまま通る。

`App.vue` のテンプレート:

```vue
    <ComposeView
      v-else-if="composing"
      :session="session"
      :storage="storage"
      @posted="(id: string) => { composing = false; notifyMessageId = id }"
      @cancel="composing = false"
    />
    <NotifyView
      v-else-if="notifyMessageId"
      :session="session"
      :storage="storage"
      :message-id="notifyMessageId"
      @close="notifyMessageId = null"
    />
```

- [ ] **Step 4: 全体の検証**

```bash
npm run test:run && npm run typecheck && npm run build
```

Expected: すべて成功。

- [ ] **Step 5: コミット**

```bash
git add src/notify/delivery-log.ts src/ui/NotifyView.vue src/ui/ComposeView.vue src/db/group-db.ts src/App.vue tests/notify/ tests/ui/
git commit -m "feat(notify): add the mailto batch sender with a local delivery log"
```

---

## Phase 2e 完了条件

- `npm run test:run` が全て green。**3回連続で通ること**
- `npm run typecheck` がエラーなし
- `npm run build` が成功する
- 不在連絡が担当者の画面に出て、参加者には出ない(Task 1)
- mailto の宛先が TO ではなく BCC に入る(Task 4)
- メッセージ本文がメールに載らない(Task 4)
- メール未登録の人数が画面に出る(Task 3, 5)

## 次フェーズへの引き継ぎ

- **`DEFAULT_MAX_URL_LENGTH` は実機未検証の保守的な値。** 検証課題 §16-1(mailto URL 長の実用上限)を実機で確かめたら、この定数と設計書を同時に更新する
- **TO に入れるグループ共用アドレスが未設定。** 今は空文字なので、多くのメーラーは BCC だけの下書きを開く。グループ設定に持たせるのは開設ウィザード(Phase 2f)
- グループ設定の編集画面(メールテンプレート・定型理由・通知停止)。読み書きの土台は Task 2 で用意した
- `DEFAULT_REASONS` を `group-settings` の `absenceReasons` から読むように `AbsenceView` を差し替える
- Web Push と関数層 → Phase 3
- 開設ウィザード・接続確認・リカバリキット → Phase 2f
