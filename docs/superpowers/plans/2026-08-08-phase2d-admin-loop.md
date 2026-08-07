# Phase 2d: 管理者の運用ループ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 2c で作った上り経路を実際に使える状態にする。担当者が投函枠を配り、届いた不在連絡とメールアドレス登録を回収して適用し、その結果が両側の画面に出るところまで閉じる。

**Architecture:** 上りは inbox に溜まるだけで、誰かが適用しない限り何も起きない。適用は担当者・管理者の端末が担う。不在連絡はイベントログへ転記して全担当者に行き渡らせ、メールアドレスは名簿の staff 部へ書き戻す。**名簿の再署名は管理者だけができる**(信頼の根である ECDSA 鍵を持つのが管理者だけのため)。担当者は不在連絡の転記までを担当し、名簿更新は管理者の作業として分ける。

**Tech Stack:** Vue 3 / TypeScript / Vite / Vitest / Dexie.js / Web Crypto API

正は [要件書](../../Mofune%20-%20要件書.md) / [設計書](../../Mofune%20-%20設計書.md)。Phase 1 / 2a / 2b / 2c の成果物の上に載る。

## Global Constraints

Phase 1〜2c の Global Constraints をすべて引き継ぐ。特に:

- 暗号プリミティブは Web Crypto API のみ。例外は Argon2id (hash-wasm) のみ
- **バイト列の型は `Bytes`**(= `Uint8Array<ArrayBuffer>`)。型注釈上の `Uint8Array` は `Bytes` と読み替え、テストの `as Uint8Array` も `as Bytes` にする。**これを忘れると型チェックだけが落ちる**(テストは通ってしまう)ので、各タスクで `npm run typecheck` まで確認してからコミットする
- 秘密鍵・パスワード・ストレージ資格情報を IndexedDB / localStorage に保存してはならない
- 参加者からの上りに staff スコープ鍵を使ってはならない(設計書 §4.6)
- 既読情報を送出してはならない(要件書 §4.10)
- ストレージパスを組み立てる箇所は `assertSafePath` を通す
- **UI テストの待機は `vi.waitFor` で「実際に検証したい条件」を待つ。** 途中の状態(キューに積まれた、1つ目のオブジェクトが書けた)を待つとフレーキーになる。Phase 2b/2c で3回踏んだ
- `tsconfig.json` は `strict: true` と `verbatimModuleSyntax: true`
- テストは `tests/**/*.test.ts`。`import { describe, it, expect } from 'vitest'` を明示する
- DOM が要るテストはファイル先頭に `// @vitest-environment happy-dom`
- コミットは Conventional Commits 形式。`Co-Authored-By` 行は付けない
- 実行時に外部CDNへ接続しない

## 既存インターフェース(実装前に確認済み)

```ts
// src/crypto/roster.ts
interface RosterMember { userId: string; displayName: string; role: Role; scopes: string[]; ecdhPublic: string; ecdsaPublic: string }
interface RosterContents { groupId: string; generation: number; subgroups: Subgroup[]; members: RosterMember[] }
interface RosterFile { v: number; contents: string; staffSection: string | null; signature: string; adminPublicKey: string }
signRoster(contents: RosterContents, staffSection: Bytes | null, adminEcdsa: RawKeyPair): Promise<RosterFile>
verifyRoster(file: RosterFile, trustedAdminPublicKey: Bytes): Promise<RosterContents>
serializeRosterFile(file: RosterFile): Bytes
parseRosterFile(bytes: Bytes): RosterFile
const ALL_SCOPE = 'all'; const STAFF_SCOPE = 'staff'

// src/crypto/keyring.ts
keyId(scope: string, generation: number): string

// src/crypto/envelope.ts
sealEnvelope(key: CryptoKey, keyId: string, plaintext: Bytes): Promise<Bytes>
openEnvelopeWithKey(key: CryptoKey, bytes: Bytes): Promise<Bytes>

// src/group/provision.ts
const STAFF_SECTION_KEY_ID  // keyId(STAFF_SCOPE, 1)
// 連絡先の形は Record<userId, { email: string }>

// src/group/session.ts
interface Session { groupId; groupName; userId; displayName; role; scopes; groupKeys; roster; ecdhPrivate; ecdsaPrivate }
// 管理者の ecdsaPrivate は接続コードの adminPublicKey に対応する信頼の根そのもの

// src/inbox/collect.ts
interface CollectedItem { key: string; body: Bytes }
interface CollectResult { items: CollectedItem[]; unreadable: number }
collectInbox(options: { storage; session }): Promise<CollectResult>
discardInboxItem(options: { storage; key: string }): Promise<void>

// src/inbox/grants.ts
publishGrants(options: { storage; groupId; roster; settings; now? }): Promise<string[]>

// src/content/absence.ts
interface AbsenceReport { id: string; kind: AbsenceKind; date: string; reason: string; note: string; author: string; at: string }
parseAbsenceReport(bytes: Bytes): AbsenceReport

// src/group/email-registration.ts
interface EmailRegistration { v: number; userId: string; email: string; at: string }
parseEmailRegistration(bytes: Bytes): EmailRegistration

// src/sync/events.ts
type EventType = 'MESSAGE_CREATED' | 'FILE_ADDED' | 'MEMBER_UPDATED'
interface GroupEvent { id: string; type: EventType; author: string; at: string; payload: Record<string, unknown> }
newEventId(now?: Date): string; eventPathFor(groupId, id): string; sealEvent(event, targets): Promise<Bytes>

// src/db/group-db.ts
class GroupDatabase extends Dexie { messages; files; events; roster; outbox; syncState }
// version(1) のみ。テーブル追加には version(2) が要る

// src/group/storage-credentials.ts
readStorageSettings(options: { storage; groupId; keys }): Promise<StorageSettings>
```

## File Structure

```
src/group/contacts.ts        名簿 staff 部(連絡先)の読み書き           Task 1
src/group/roster-update.ts   名簿の更新と再署名(管理者のみ)            Task 2
src/sync/events.ts           ABSENCE_REPORTED を追加(既存を変更)       Task 3
src/db/group-db.ts           absences テーブルを追加 (version 2)         Task 3
src/sync/projection.ts       不在連絡の投影(既存を変更)                Task 3
src/inbox/apply.ts           投函物の振り分けと適用                      Task 4
src/ui/StaffPanelView.vue    担当者パネル (grant配布 / inbox処理 / 一覧)  Task 5
src/App.vue                  画面遷移の配線(既存を変更)                Task 5
```

---

### Task 1: 名簿 staff 部(連絡先)の読み書き

**Files:**
- Create: `src/group/contacts.ts`
- Test: `tests/group/contacts.test.ts`

**Interfaces:**
- Consumes: `Bytes` / `fromBase64` / `toBase64` / `fromUtf8` / `utf8`、`sealEnvelope` / `openEnvelopeWithKey`、`keyId` / `STAFF_SCOPE`、`RosterFile`
- Produces: `class ContactsError extends Error`、`interface Contact { email: string }`、`type ContactBook = Record<string, Contact>`、`staffSectionKeyId(generation: number): string` / `readContacts(options: { file: RosterFile; staffKey: CryptoKey }): Promise<ContactBook>` / `sealContacts(options: { contacts: ContactBook; staffKey: CryptoKey; generation: number }): Promise<Bytes>` / `withContact(contacts: ContactBook, userId: string, email: string): ContactBook`

名簿は「公開部 + staff スコープで暗号化された連絡先部」の2部構成(設計書 §4.2)。ここは連絡先部だけを扱う。

`provisionGroup` が書く形は `Record<userId, { email: string }>` で、`sealEnvelope(staffKey, STAFF_SECTION_KEY_ID, …)` で封緘されている。**その形をそのまま読み書きする。** 形を変えると開設済みのグループが読めなくなる。

`withContact` は純関数にしておく。名簿更新(Task 2)は再署名を伴う重い処理なので、連絡先の組み立てだけを切り離してテストしやすくする。

- [ ] **Step 1: 失敗するテストを書く**

`tests/group/contacts.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  ContactsError,
  readContacts,
  sealContacts,
  staffSectionKeyId,
  withContact,
} from '../../src/group/contacts'
import type { ContactBook } from '../../src/group/contacts'
import type { RosterFile } from '../../src/crypto/roster'
import { generateAesKey } from '../../src/crypto/symmetric'
import { toBase64 } from '../../src/crypto/bytes'

const contacts: ContactBook = {
  u_sato: { email: 'sakura@example.com' },
  u_mori: { email: 'yui@example.com' },
}

function fileWith(staffSection: string | null): RosterFile {
  return {
    v: 1,
    contents: 'x',
    staffSection,
    signature: 'x',
    adminPublicKey: 'x',
  }
}

describe('staffSectionKeyId', () => {
  it('is the staff scope at the given generation', () => {
    expect(staffSectionKeyId(1)).toBe('staff:v1')
    expect(staffSectionKeyId(3)).toBe('staff:v3')
  })
})

describe('withContact', () => {
  it('adds a new address', () => {
    expect(withContact({}, 'u_sato', 'sakura@example.com')).toEqual({
      u_sato: { email: 'sakura@example.com' },
    })
  })

  it('replaces an existing address', () => {
    const updated = withContact(contacts, 'u_sato', 'new@example.com')
    expect(updated['u_sato']?.email).toBe('new@example.com')
  })

  it('leaves the other entries alone', () => {
    const updated = withContact(contacts, 'u_sato', 'new@example.com')
    expect(updated['u_mori']?.email).toBe('yui@example.com')
  })

  it('does not mutate its input', () => {
    withContact(contacts, 'u_sato', 'new@example.com')
    expect(contacts['u_sato']?.email).toBe('sakura@example.com')
  })
})

describe('sealContacts / readContacts', () => {
  it('round-trips the contact book', async () => {
    const staffKey = await generateAesKey()
    const sealed = await sealContacts({ contacts, staffKey, generation: 1 })
    const file = fileWith(toBase64(sealed))
    expect(await readContacts({ file, staffKey })).toEqual(contacts)
  })

  it('does not leave any address in the ciphertext', async () => {
    const staffKey = await generateAesKey()
    const sealed = await sealContacts({ contacts, staffKey, generation: 1 })
    expect(new TextDecoder().decode(sealed)).not.toContain('sakura@example.com')
  })

  it('cannot be read with a different key', async () => {
    const sealed = await sealContacts({ contacts, staffKey: await generateAesKey(), generation: 1 })
    const file = fileWith(toBase64(sealed))
    await expect(readContacts({ file, staffKey: await generateAesKey() })).rejects.toThrow(
      ContactsError,
    )
  })

  it('treats a roster with no staff section as an empty book', async () => {
    const staffKey = await generateAesKey()
    expect(await readContacts({ file: fileWith(null), staffKey })).toEqual({})
  })

  it('reports a staff section that is not a contact book', async () => {
    const staffKey = await generateAesKey()
    const { sealEnvelope } = await import('../../src/crypto/envelope')
    const { utf8 } = await import('../../src/crypto/bytes')
    const bogus = await sealEnvelope(staffKey, 'staff:v1', utf8('"not an object"'))
    await expect(readContacts({ file: fileWith(toBase64(bogus)), staffKey })).rejects.toThrow(
      ContactsError,
    )
  })

  it('reads back what provisionGroup wrote', async () => {
    // 開設時の形を変えると既存グループが読めなくなるので、実物で確かめる
    const { provisionGroup } = await import('../../src/group/provision')
    const { parseRosterFile } = await import('../../src/crypto/roster')
    const { parseKeystoreFile, unlockKeystore } = await import('../../src/crypto/keystore')
    const { parseKeyringFile, unlockKeyring } = await import('../../src/crypto/keyring')
    const { rosterPath, keyringPath, keystorePath } = await import('../../src/storage/paths')
    const { TEST_KDF } = await import('../../src/crypto/kdf')

    const result = await provisionGroup({
      groupId: 'midori',
      groupName: 'みどり台グループ',
      provider: 'http',
      root: 'https://example.invalid/mofune',
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
    const file = parseRosterFile(result.objects.get(rosterPath('midori')) as never)
    const keystore = await unlockKeystore(
      parseKeystoreFile(result.objects.get(await keystorePath('midori', 'watanabe')) as never),
      'admin-pass',
      result.code.pepper,
    )
    const keyring = parseKeyringFile(result.objects.get(keyringPath('midori', 1)) as never)
    const keys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)
    const staffKey = keys.get('staff:v1') as CryptoKey

    const book = await readContacts({ file, staffKey })
    expect(Object.values(book).map((c) => c.email)).toContain('watanabe@example.invalid')
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/group/contacts.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/group/contacts"`

- [ ] **Step 3: 実装する**

`src/group/contacts.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import { fromBase64, fromUtf8, utf8 } from '../crypto/bytes'
import { openEnvelopeWithKey, sealEnvelope } from '../crypto/envelope'
import { keyId } from '../crypto/keyring'
import type { RosterFile } from '../crypto/roster'
import { STAFF_SCOPE } from '../crypto/roster'

export class ContactsError extends Error {}

export interface Contact {
  email: string
}

/** userId -> 連絡先。provisionGroup が書く形と同じ。 */
export type ContactBook = Record<string, Contact>

export function staffSectionKeyId(generation: number): string {
  return keyId(STAFF_SCOPE, generation)
}

/** 連絡先を1件足すか置き換える。入力は変更しない。 */
export function withContact(
  contacts: ContactBook,
  userId: string,
  email: string,
): ContactBook {
  return { ...contacts, [userId]: { email } }
}

export async function sealContacts(options: {
  contacts: ContactBook
  staffKey: CryptoKey
  generation: number
}): Promise<Bytes> {
  return sealEnvelope(
    options.staffKey,
    staffSectionKeyId(options.generation),
    utf8(JSON.stringify(options.contacts)),
  )
}

/** 名簿の staff 部を復号する。担当者・管理者だけが持つ鍵が要る。 */
export async function readContacts(options: {
  file: RosterFile
  staffKey: CryptoKey
}): Promise<ContactBook> {
  if (options.file.staffSection === null) return {}

  let plaintext: Bytes
  try {
    plaintext = await openEnvelopeWithKey(
      options.staffKey,
      fromBase64(options.file.staffSection),
    )
  } catch {
    throw new ContactsError('the staff section could not be decrypted with this key')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(plaintext))
  } catch {
    throw new ContactsError('the staff section is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ContactsError('the staff section is not a contact book')
  }
  return parsed as ContactBook
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/group/contacts.test.ts && npm run typecheck
```

Expected: 11 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/group/contacts.ts tests/group/contacts.test.ts
git commit -m "feat(group): read and write the staff-only contact section"
```

---

### Task 2: 名簿の更新と再署名

**Files:**
- Create: `src/group/roster-update.ts`
- Test: `tests/group/roster-update.test.ts`

**Interfaces:**
- Consumes: Task 1 の `ContactBook` / `readContacts` / `sealContacts` / `withContact`、`RosterContents` / `RosterFile` / `signRoster` / `verifyRoster` / `parseRosterFile` / `serializeRosterFile`、`rosterPath`、`StorageProvider`、`Session`
- Produces: `class RosterUpdateError extends Error`、`interface RosterUpdateResult { generation: number; contacts: ContactBook }`、`loadRosterFile(options: { storage: StorageProvider; groupId: string }): Promise<RosterFile>` / `updateContacts(options: { storage: StorageProvider; session: Session; adminPublicKey: Bytes; staffKey: CryptoKey; generation: number; updates: Array<{ userId: string; email: string }> }): Promise<RosterUpdateResult>`

**名簿を再署名できるのは管理者だけである。** 信頼の根は接続コードの `adminPublicKey` で、それに対応する秘密鍵は管理者のキーストアにしかない。担当者が呼んだら `RosterUpdateError` にする。黙って何もしないのではなく、なぜできないかを画面に出せるようにする。

更新のたびに `generation` を1つ進める。読み手が「新しいほうを採用する」判断をできるようにするため。

**書き込む前に、自分が作った名簿が自分で検証できることを確かめる。** 署名を間違えた名簿を置くと、全員がログインできなくなる(ログインは名簿の署名検証を通るため)。取り返しがつかないので、書き込み前の自己検証を必須にする。

- [ ] **Step 1: 失敗するテストを書く**

`tests/group/roster-update.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { RosterUpdateError, loadRosterFile, updateContacts } from '../../src/group/roster-update'
import { readContacts } from '../../src/group/contacts'
import { provisionGroup } from '../../src/group/provision'
import { parseKeystoreFile, unlockKeystore } from '../../src/crypto/keystore'
import { parseKeyringFile, unlockKeyring } from '../../src/crypto/keyring'
import { verifyRoster } from '../../src/crypto/roster'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { keyringPath, keystorePath, rosterPath } from '../../src/storage/paths'
import { fromBase64 } from '../../src/crypto/bytes'
import type { Bytes } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'

async function provisioned() {
  const result = await provisionGroup({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    provider: 'http',
    root: 'https://example.invalid/mofune',
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
      {
        loginId: 'tanaka',
        displayName: '田中 みか',
        role: 'staff',
        scopes: [],
        password: 'staff-pass',
        email: 'tanaka@example.invalid',
      },
      {
        loginId: 'sato',
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: [],
        password: 'member-pass',
        email: '',
      },
    ],
  })
  const storage = new MemoryStorageProvider()
  for (const [path, body] of result.objects) await storage.put(path, body)

  const open = async (loginId: string, password: string) => {
    const keystore = await unlockKeystore(
      parseKeystoreFile(result.objects.get(await keystorePath('midori', loginId)) as Bytes),
      password,
      result.code.pepper,
    )
    const keyring = parseKeyringFile(result.objects.get(keyringPath('midori', 1)) as Bytes)
    const keys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)
    return { keystore, keys }
  }

  const admin = await open('watanabe', 'admin-pass')
  const staff = await open('tanaka', 'staff-pass')
  const satoUserId = (
    await verifyRoster(
      (await import('../../src/crypto/roster')).parseRosterFile(
        result.objects.get(rosterPath('midori')) as Bytes,
      ),
      fromBase64(result.code.adminPublicKey),
    )
  ).members.find((m) => m.displayName === '佐藤 さくら')?.userId as string

  const sessionFor = (
    who: typeof admin,
    role: 'admin' | 'staff',
    displayName: string,
  ): Session => ({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: who.keystore.userId,
    displayName,
    role,
    scopes: ['all', 'staff'],
    groupKeys: who.keys,
    roster: { groupId: 'midori', generation: 1, subgroups: [], members: [] },
    ecdhPrivate: who.keystore.ecdh.privateKey,
    ecdsaPrivate: who.keystore.ecdsa.privateKey,
  })

  return {
    storage,
    code: result.code,
    adminPublicKey: fromBase64(result.code.adminPublicKey),
    adminSession: sessionFor(admin, 'admin', '渡辺 けい'),
    staffSession: sessionFor(staff, 'staff', '田中 みか'),
    staffKey: admin.keys.get('staff:v1') as CryptoKey,
    satoUserId,
  }
}

describe('loadRosterFile', () => {
  it('reads the roster written at provisioning time', async () => {
    const { storage } = await provisioned()
    const file = await loadRosterFile({ storage, groupId: 'midori' })
    expect(file.staffSection).not.toBeNull()
  })

  it('reports a missing roster', async () => {
    await expect(
      loadRosterFile({ storage: new MemoryStorageProvider(), groupId: 'midori' }),
    ).rejects.toThrow(RosterUpdateError)
  })
})

describe('updateContacts', () => {
  it('adds the address to the contact book', async () => {
    const ctx = await provisioned()
    const result = await updateContacts({
      storage: ctx.storage,
      session: ctx.adminSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [{ userId: ctx.satoUserId, email: 'sakura@example.com' }],
    })
    expect(result.contacts[ctx.satoUserId]?.email).toBe('sakura@example.com')
  })

  it('writes a roster that still verifies against the connection code key', async () => {
    const ctx = await provisioned()
    await updateContacts({
      storage: ctx.storage,
      session: ctx.adminSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [{ userId: ctx.satoUserId, email: 'sakura@example.com' }],
    })
    const file = await loadRosterFile({ storage: ctx.storage, groupId: 'midori' })
    await expect(verifyRoster(file, ctx.adminPublicKey)).resolves.toBeDefined()
  })

  it('keeps the addresses that were already there', async () => {
    const ctx = await provisioned()
    const result = await updateContacts({
      storage: ctx.storage,
      session: ctx.adminSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [{ userId: ctx.satoUserId, email: 'sakura@example.com' }],
    })
    expect(Object.values(result.contacts).map((c) => c.email)).toContain(
      'watanabe@example.invalid',
    )
  })

  it('advances the roster generation', async () => {
    const ctx = await provisioned()
    const result = await updateContacts({
      storage: ctx.storage,
      session: ctx.adminSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [{ userId: ctx.satoUserId, email: 'sakura@example.com' }],
    })
    expect(result.generation).toBe(2)
    const file = await loadRosterFile({ storage: ctx.storage, groupId: 'midori' })
    const contents = await verifyRoster(file, ctx.adminPublicKey)
    expect(contents.generation).toBe(2)
  })

  it('keeps the contact section readable with the staff key', async () => {
    const ctx = await provisioned()
    await updateContacts({
      storage: ctx.storage,
      session: ctx.adminSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [{ userId: ctx.satoUserId, email: 'sakura@example.com' }],
    })
    const file = await loadRosterFile({ storage: ctx.storage, groupId: 'midori' })
    const book = await readContacts({ file, staffKey: ctx.staffKey })
    expect(book[ctx.satoUserId]?.email).toBe('sakura@example.com')
  })

  it('applies several updates at once', async () => {
    const ctx = await provisioned()
    const result = await updateContacts({
      storage: ctx.storage,
      session: ctx.adminSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [
        { userId: ctx.satoUserId, email: 'sakura@example.com' },
        { userId: ctx.satoUserId, email: 'sakura2@example.com' },
      ],
    })
    expect(result.contacts[ctx.satoUserId]?.email).toBe('sakura2@example.com')
  })

  it('refuses when a staff member tries to re-sign the roster', async () => {
    const ctx = await provisioned()
    await expect(
      updateContacts({
        storage: ctx.storage,
        session: ctx.staffSession,
        adminPublicKey: ctx.adminPublicKey,
        staffKey: ctx.staffKey,
        generation: 1,
        updates: [{ userId: ctx.satoUserId, email: 'sakura@example.com' }],
      }),
    ).rejects.toThrow(RosterUpdateError)
  })

  it('leaves the stored roster untouched when it refuses', async () => {
    const ctx = await provisioned()
    const before = await loadRosterFile({ storage: ctx.storage, groupId: 'midori' })
    await updateContacts({
      storage: ctx.storage,
      session: ctx.staffSession,
      adminPublicKey: ctx.adminPublicKey,
      staffKey: ctx.staffKey,
      generation: 1,
      updates: [{ userId: ctx.satoUserId, email: 'x@example.com' }],
    }).catch(() => undefined)
    const after = await loadRosterFile({ storage: ctx.storage, groupId: 'midori' })
    expect(after.signature).toBe(before.signature)
  })

  it('refuses when the admin key does not match the connection code', async () => {
    const ctx = await provisioned()
    const { generateEcdsaKeyPair } = await import('../../src/crypto/asymmetric')
    const impostor = await generateEcdsaKeyPair()
    await expect(
      updateContacts({
        storage: ctx.storage,
        session: { ...ctx.adminSession, ecdsaPrivate: impostor.privateKey },
        adminPublicKey: ctx.adminPublicKey,
        staffKey: ctx.staffKey,
        generation: 1,
        updates: [{ userId: ctx.satoUserId, email: 'x@example.com' }],
      }),
    ).rejects.toThrow(RosterUpdateError)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/group/roster-update.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/group/roster-update"`

- [ ] **Step 3: 実装する**

`src/group/roster-update.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import { fromBase64 } from '../crypto/bytes'
import type { RosterContents, RosterFile } from '../crypto/roster'
import {
  parseRosterFile,
  serializeRosterFile,
  signRoster,
  verifyRoster,
} from '../crypto/roster'
import { rosterPath } from '../storage/paths'
import type { StorageProvider } from '../storage/provider'
import type { ContactBook } from './contacts'
import { readContacts, sealContacts, withContact } from './contacts'
import type { Session } from './session'

export class RosterUpdateError extends Error {}

export interface RosterUpdateResult {
  generation: number
  contacts: ContactBook
}

export async function loadRosterFile(options: {
  storage: StorageProvider
  groupId: string
}): Promise<RosterFile> {
  try {
    return parseRosterFile(await options.storage.get(rosterPath(options.groupId)))
  } catch {
    throw new RosterUpdateError(`no roster could be read for group "${options.groupId}"`)
  }
}

/**
 * 連絡先を更新し、名簿を再署名して書き戻す。
 *
 * 再署名できるのは管理者だけ。信頼の根は接続コードの adminPublicKey で、
 * 対応する秘密鍵は管理者のキーストアにしかない。
 */
export async function updateContacts(options: {
  storage: StorageProvider
  session: Session
  adminPublicKey: Bytes
  staffKey: CryptoKey
  generation: number
  updates: Array<{ userId: string; email: string }>
}): Promise<RosterUpdateResult> {
  if (options.session.role !== 'admin') {
    throw new RosterUpdateError('only an admin can re-sign the roster')
  }

  const file = await loadRosterFile({
    storage: options.storage,
    groupId: options.session.groupId,
  })
  const contents = await verifyRoster(file, options.adminPublicKey)

  let contacts = await readContacts({ file, staffKey: options.staffKey })
  for (const update of options.updates) {
    contacts = withContact(contacts, update.userId, update.email)
  }

  const generation = contents.generation + 1
  const next: RosterContents = { ...contents, generation }
  const staffSection = await sealContacts({
    contacts,
    staffKey: options.staffKey,
    generation: options.generation,
  })
  const signed = await signRoster(next, staffSection, {
    publicKey: options.adminPublicKey,
    privateKey: options.session.ecdsaPrivate,
  })

  // 署名を誤った名簿を置くと全員がログインできなくなる。書き込む前に自分で検証する。
  try {
    await verifyRoster(signed, options.adminPublicKey)
  } catch {
    throw new RosterUpdateError(
      'the freshly signed roster does not verify; refusing to publish it',
    )
  }

  await options.storage.put(
    rosterPath(options.session.groupId),
    serializeRosterFile(signed),
  )
  return { generation, contacts }
}
```

`fromBase64` を使っていない場合は import から外すこと(`noUnusedLocals` が有効)。

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/group/roster-update.test.ts && npm run typecheck
```

Expected: 11 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/group/roster-update.ts tests/group/roster-update.test.ts
git commit -m "feat(group): let the admin update contacts and re-sign the roster"
```

---
### Task 3: 不在連絡をイベントに載せて投影する

**Files:**
- Modify: `src/sync/events.ts`(`EventType` に `ABSENCE_REPORTED` を追加)
- Modify: `src/db/group-db.ts`(`absences` テーブルを追加。Dexie を version 2 へ)
- Modify: `src/sync/projection.ts`(不在連絡の投影を追加)
- Test: `tests/db/group-db.test.ts`(既存に追記)
- Test: `tests/sync/projection.test.ts`(既存に追記)

**Interfaces:**
- Consumes: `AbsenceReport` / `parseAbsenceReport`、`GroupEvent`
- Produces: `type EventType = 'MESSAGE_CREATED' | 'FILE_ADDED' | 'MEMBER_UPDATED' | 'ABSENCE_REPORTED'`、`interface CachedAbsence { id: string; kind: string; date: string; reason: string; note: string; author: string; at: string }`、`GroupDatabase.absences: Table<CachedAbsence, string>`

回収した不在連絡は、担当者ひとりの端末に留めず**イベントログへ転記する**。そうしないと、回収した担当者以外は誰も見られない。転記自体は Task 4 が行い、ここは「イベント種別」「保存先テーブル」「投影」を用意する。

**Dexie のバージョンを 2 に上げる。** テーブル追加はスキーマ変更なので、`version(1)` の定義を残したまま `version(2)` を足す。消してはならない。既存の端末が v1 の DB を持っており、v1 の定義が無いと移行できない。

不在連絡の中身は staff スコープ宛のイベントに載せる。参加者に配ると、他人の欠席理由が全員に見えてしまう。

- [ ] **Step 1: 失敗するテストを書く**

`tests/db/group-db.test.ts` の `describe('group database')` の中に追記する。

```ts
  it('stores absences and finds them by id', async () => {
    const db = openGroupDatabase('midori')
    await db.absences.put({
      id: 'ab_1',
      kind: 'absent',
      date: '2026-08-08',
      reason: '体調不良',
      note: '朝から熱があります',
      author: 'u_sato',
      at: '2026-08-08T07:30:00.000Z',
    })
    expect((await db.absences.get('ab_1'))?.reason).toBe('体調不良')
  })

  it('keeps absences out of the message table', async () => {
    const db = openGroupDatabase('midori')
    await db.absences.put({
      id: 'ab_1',
      kind: 'absent',
      date: '2026-08-08',
      reason: '',
      note: '',
      author: 'u_sato',
      at: '2026-08-08T07:30:00.000Z',
    })
    expect(await db.messages.count()).toBe(0)
  })
```

`tests/sync/projection.test.ts` の `describe('projectEvent')` の中に追記する。

```ts
  it('projects an absence event into the absences table', async () => {
    const { session, storage } = await postedEvent()
    const db = openGroupDatabase('midori')
    const event: GroupEvent = {
      id: '20260808T073000Z-aaaa',
      type: 'ABSENCE_REPORTED',
      author: 'u_tanaka',
      at: '2026-08-08T07:30:00.000Z',
      payload: {
        absence: {
          id: 'ab_1',
          kind: 'absent',
          date: '2026-08-08',
          reason: '体調不良',
          note: '朝から熱があります',
          author: 'u_sato',
          at: '2026-08-08T07:30:00.000Z',
        },
      },
    }
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event,
    })
    expect(result.absences).toBe(1)
    expect((await db.absences.get('ab_1'))?.note).toBe('朝から熱があります')
  })

  it('is idempotent for absence events', async () => {
    const { session, storage } = await postedEvent()
    const db = openGroupDatabase('midori')
    const event: GroupEvent = {
      id: '20260808T073000Z-bbbb',
      type: 'ABSENCE_REPORTED',
      author: 'u_tanaka',
      at: '2026-08-08T07:30:00.000Z',
      payload: {
        absence: {
          id: 'ab_2',
          kind: 'late',
          date: '2026-08-08',
          reason: '',
          note: '',
          author: 'u_sato',
          at: '2026-08-08T07:30:00.000Z',
        },
      },
    }
    await projectEvent({ db, storage, groupId: 'midori', keys: session.groupKeys, event })
    await projectEvent({ db, storage, groupId: 'midori', keys: session.groupKeys, event })
    expect(await db.absences.count()).toBe(1)
  })

  it('reports an absence event with no payload as missing', async () => {
    const { session, storage } = await postedEvent()
    const db = openGroupDatabase('midori')
    const event: GroupEvent = {
      id: '20260808T073000Z-cccc',
      type: 'ABSENCE_REPORTED',
      author: 'u_tanaka',
      at: '2026-08-08T07:30:00.000Z',
      payload: {},
    }
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event,
    })
    expect(result.missing).toBe(1)
    expect(await db.absences.count()).toBe(0)
  })
```

既存の `projectEvent` の戻り値を `toEqual({ messages: 0, files: 0, absences: 0, missing: 0 })` と比較しているテストは、`absences` が増えるので `toEqual({ messages: 0, files: 0, absences: 0, missing: 0 })` に直す。

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/db/group-db.test.ts tests/sync/projection.test.ts
```

Expected: FAIL — `db.absences` が undefined で落ちる。

- [ ] **Step 3: 実装する**

`src/sync/events.ts` の `EventType` と定数を広げる。

```ts
export type EventType =
  | 'MESSAGE_CREATED'
  | 'FILE_ADDED'
  | 'MEMBER_UPDATED'
  | 'ABSENCE_REPORTED'

const EVENT_TYPES: readonly string[] = [
  'MESSAGE_CREATED',
  'FILE_ADDED',
  'MEMBER_UPDATED',
  'ABSENCE_REPORTED',
]
```

`src/db/group-db.ts` にテーブルを足す。

```ts
export interface CachedAbsence {
  id: string
  kind: string
  date: string
  reason: string
  note: string
  author: string
  at: string
}
```

`GroupDatabase` にフィールドを足す。

```ts
  absences!: Table<CachedAbsence, string>
```

コンストラクタでは **version(1) を残したまま** version(2) を足す。

```ts
  constructor(groupId: string) {
    super(`mofune_${groupId}`)
    // v1 の定義は消さない。既存端末の DB を移行するために必要。
    this.version(1).stores({
      messages: 'id, at',
      files: 'id, cachedAt',
      events: 'id',
      roster: 'groupId',
      outbox: 'id, queuedAt',
      syncState: 'key',
    })
    this.version(2).stores({
      messages: 'id, at',
      files: 'id, cachedAt',
      events: 'id',
      roster: 'groupId',
      outbox: 'id, queuedAt',
      syncState: 'key',
      absences: 'id, date',
    })
  }
```

`src/sync/projection.ts` に投影を足す。`ProjectionResult` に `absences` を追加する。

```ts
export interface ProjectionResult {
  messages: number
  files: number
  absences: number
  missing: number
}
```

`projectEvent` の冒頭を書き換える。

```ts
  const result: ProjectionResult = { messages: 0, files: 0, absences: 0, missing: 0 }

  if (options.event.type === 'ABSENCE_REPORTED') {
    const absence = options.event.payload['absence']
    if (absence === null || typeof absence !== 'object') {
      result.missing += 1
      return result
    }
    const cached = absence as CachedAbsence
    if (typeof cached.id !== 'string') {
      result.missing += 1
      return result
    }
    await options.db.absences.put(cached)
    result.absences += 1
    return result
  }

  if (options.event.type !== 'MESSAGE_CREATED') {
    return result
  }
```

`CachedAbsence` を `import type` で足すこと。`syncGroup` の戻り値は `missing` を集計しているだけなので変更不要。

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/db/ tests/sync/ && npm run typecheck
```

Expected: すべて green、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/sync/events.ts src/db/group-db.ts src/sync/projection.ts tests/db/group-db.test.ts tests/sync/projection.test.ts
git commit -m "feat(sync): carry absence reports on the event log"
```

---

### Task 4: 投函物の振り分けと適用

**Files:**
- Create: `src/inbox/apply.ts`
- Test: `tests/inbox/apply.test.ts`

**Interfaces:**
- Consumes: Task 2 の `updateContacts`、Task 3 の `ABSENCE_REPORTED`、`CollectedItem` / `collectInbox` / `discardInboxItem`、`parseAbsenceReport`、`parseEmailRegistration`、`newEventId` / `eventPathFor` / `sealEvent`、`keyId` / `STAFF_SCOPE`、`Session`、`StorageProvider`、`Bytes` / `fromUtf8`
- Produces: `type SubmissionKind = 'absence' | 'email' | 'unknown'`、`interface ApplyResult { absences: number; emails: number; unknown: number; unreadable: number; pendingContactUpdates: Array<{ userId: string; email: string }> }`、`classifySubmission(body: Bytes): SubmissionKind` / `applyInbox(options: { storage: StorageProvider; session: Session; now?: Date }): Promise<ApplyResult>`

回収した投函物を種類ごとに処理する。

- **不在連絡** → staff スコープ宛のイベントとしてストレージへ書き、投函物を削除する
- **メールアドレス登録** → `pendingContactUpdates` に積んで返す。**ここでは名簿を書き換えない**
- **どちらでもない** → `unknown` に数え、投函物は**削除しない**(判別できないものを消すと復旧できない)

メールアドレスを即座に名簿へ書かないのは、名簿の再署名が管理者にしかできないため(Task 2)。担当者が回収したときは更新内容を返すだけにして、管理者が適用する。呼び出し側(Task 5)が管理者なら続けて `updateContacts` を呼ぶ。

**適用してから削除する。** 逆にすると、イベント書き込みに失敗したときに投函物が失われる。

- [ ] **Step 1: 失敗するテストを書く**

`tests/inbox/apply.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { applyInbox, classifySubmission } from '../../src/inbox/apply'
import { sealForRecipients } from '../../src/inbox/uplink'
import { grantPath } from '../../src/inbox/grants'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { toBase64, utf8 } from '../../src/crypto/bytes'
import { openEvent } from '../../src/sync/events'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

const now = new Date('2026-08-08T09:00:00.000Z')

const absence = {
  id: 'ab_1',
  kind: 'absent',
  date: '2026-08-08',
  reason: '体調不良',
  note: '朝から熱があります',
  author: 'u_sato',
  at: '2026-08-08T07:30:00.000Z',
}
const registration = {
  v: 1,
  userId: 'u_sato',
  email: 'sakura@example.com',
  at: '2026-08-08T07:35:00.000Z',
}

async function fixture() {
  const staff = await generateEcdhKeyPair()
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
    roster,
    ecdhPrivate: staff.privateKey,
    ecdsaPrivate: new Uint8Array(0),
  }
  const recipients = [{ userId: 'u_tanaka', ecdhPublic: toBase64(staff.publicKey) }]
  const storage = new MemoryStorageProvider()
  const drop = async (key: string, payload: unknown) => {
    await storage.put(key, await sealForRecipients(recipients, utf8(JSON.stringify(payload))))
  }
  return { session, storage, staffKey, drop, recipients }
}

describe('classifySubmission', () => {
  it('recognises an absence report', () => {
    expect(classifySubmission(utf8(JSON.stringify(absence)))).toBe('absence')
  })

  it('recognises an email registration', () => {
    expect(classifySubmission(utf8(JSON.stringify(registration)))).toBe('email')
  })

  it('reports anything else as unknown', () => {
    expect(classifySubmission(utf8('{"hello":"world"}'))).toBe('unknown')
    expect(classifySubmission(utf8('not json'))).toBe('unknown')
  })
})

describe('applyInbox', () => {
  it('does nothing on an empty inbox', async () => {
    const { session, storage } = await fixture()
    const result = await applyInbox({ storage, session, now })
    expect(result).toEqual({
      absences: 0,
      emails: 0,
      unknown: 0,
      unreadable: 0,
      pendingContactUpdates: [],
    })
  })

  it('writes an absence report onto the event log', async () => {
    const { session, storage, staffKey, drop } = await fixture()
    await drop('midori/inbox/u_sato/a.enc', absence)
    const result = await applyInbox({ storage, session, now })
    expect(result.absences).toBe(1)

    const events = await storage.list('midori/events/')
    expect(events).toHaveLength(1)
    const event = await openEvent(
      new Map([['staff:v1', staffKey]]),
      await storage.get(events[0]?.path as string),
    )
    expect(event.type).toBe('ABSENCE_REPORTED')
    expect((event.payload['absence'] as typeof absence).reason).toBe('体調不良')
  })

  it('addresses the absence event to the staff scope only', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/a.enc', absence)
    await applyInbox({ storage, session, now })
    const { readKeyIds } = await import('../../src/crypto/envelope')
    const events = await storage.list('midori/events/')
    expect(readKeyIds(await storage.get(events[0]?.path as string))).toEqual(['staff:v1'])
  })

  it('removes an applied absence from the inbox', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/a.enc', absence)
    await applyInbox({ storage, session, now })
    expect(await storage.list('midori/inbox/u_sato/')).toHaveLength(0)
  })

  it('returns email registrations without touching the roster', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/b.enc', registration)
    const result = await applyInbox({ storage, session, now })
    expect(result.emails).toBe(1)
    expect(result.pendingContactUpdates).toEqual([
      { userId: 'u_sato', email: 'sakura@example.com' },
    ])
    // 名簿の再署名は管理者だけができる。担当者は書き換えない。
    expect(await storage.list('midori/roster.sig.json')).toHaveLength(0)
  })

  it('removes an applied registration from the inbox', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/b.enc', registration)
    await applyInbox({ storage, session, now })
    expect(await storage.list('midori/inbox/u_sato/')).toHaveLength(0)
  })

  it('keeps an unrecognised submission instead of deleting it', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/c.enc', { hello: 'world' })
    const result = await applyInbox({ storage, session, now })
    expect(result.unknown).toBe(1)
    expect(await storage.list('midori/inbox/u_sato/')).toHaveLength(1)
  })

  it('counts packets it cannot open and leaves them alone', async () => {
    const { session, storage } = await fixture()
    const other = await generateEcdhKeyPair()
    await storage.put(
      'midori/inbox/u_sato/d.enc',
      await sealForRecipients(
        [{ userId: 'u_former', ecdhPublic: toBase64(other.publicKey) }],
        utf8(JSON.stringify(absence)),
      ),
    )
    const result = await applyInbox({ storage, session, now })
    expect(result.unreadable).toBe(1)
    expect(await storage.list('midori/inbox/u_sato/')).toHaveLength(1)
  })

  it('ignores the grant object', async () => {
    const { session, storage, drop } = await fixture()
    await drop(grantPath('midori', 'u_sato'), { v: 1, slots: [] })
    const result = await applyInbox({ storage, session, now })
    expect(result).toEqual({
      absences: 0,
      emails: 0,
      unknown: 0,
      unreadable: 0,
      pendingContactUpdates: [],
    })
    expect(await storage.get(grantPath('midori', 'u_sato'))).toBeDefined()
  })

  it('handles a mixed inbox in one pass', async () => {
    const { session, storage, drop } = await fixture()
    await drop('midori/inbox/u_sato/a.enc', absence)
    await drop('midori/inbox/u_sato/b.enc', registration)
    await drop('midori/inbox/u_mori/c.enc', { hello: 'world' })
    const result = await applyInbox({ storage, session, now })
    expect(result.absences).toBe(1)
    expect(result.emails).toBe(1)
    expect(result.unknown).toBe(1)
  })

  it('refuses when the caller is a member', async () => {
    const { session, storage } = await fixture()
    const asMember = { ...session, role: 'member' as const }
    await expect(applyInbox({ storage, session: asMember, now })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/inbox/apply.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/inbox/apply"`

- [ ] **Step 3: 実装する**

`src/inbox/apply.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import { parseAbsenceReport } from '../content/absence'
import { parseEmailRegistration } from '../group/email-registration'
import type { Session } from '../group/session'
import type { StorageProvider } from '../storage/provider'
import type { GroupEvent } from '../sync/events'
import { eventPathFor, newEventId, sealEvent } from '../sync/events'
import { collectInbox, discardInboxItem } from './collect'

export class ApplyError extends Error {}

export type SubmissionKind = 'absence' | 'email' | 'unknown'

export interface ApplyResult {
  absences: number
  emails: number
  /** 判別できなかった投函物。削除しない。 */
  unknown: number
  /** 自分の鍵では開けなかった投函物。削除しない。 */
  unreadable: number
  /** 名簿へ反映すべき連絡先。適用は管理者の作業(Task 2)。 */
  pendingContactUpdates: Array<{ userId: string; email: string }>
}

export function classifySubmission(body: Bytes): SubmissionKind {
  try {
    parseAbsenceReport(body)
    return 'absence'
  } catch {
    // 次を試す
  }
  try {
    parseEmailRegistration(body)
    return 'email'
  } catch {
    return 'unknown'
  }
}

/**
 * inbox を回収して種類ごとに処理する。
 *
 * 不在連絡は staff スコープ宛のイベントへ転記する。担当者ひとりの端末に
 * 留めると、回収した本人以外は見られないため。
 *
 * メールアドレスは名簿へ書かずに返すだけにする。名簿の再署名は管理者しか
 * できないので、担当者の回収で書き換えようとしても失敗する。
 */
export async function applyInbox(options: {
  storage: StorageProvider
  session: Session
  now?: Date
}): Promise<ApplyResult> {
  if (options.session.role === 'member') {
    throw new ApplyError('members cannot process the inbox')
  }

  const staffKeyId = keyId(STAFF_SCOPE, 1)
  const staffKey = options.session.groupKeys.get(staffKeyId)
  if (!staffKey) {
    throw new ApplyError('the staff scope key is required to process the inbox')
  }

  const collected = await collectInbox({ storage: options.storage, session: options.session })
  const result: ApplyResult = {
    absences: 0,
    emails: 0,
    unknown: 0,
    unreadable: collected.unreadable,
    pendingContactUpdates: [],
  }
  const now = options.now ?? new Date()

  for (const item of collected.items) {
    const kind = classifySubmission(item.body)

    if (kind === 'absence') {
      const report = parseAbsenceReport(item.body)
      const event: GroupEvent = {
        id: newEventId(now),
        type: 'ABSENCE_REPORTED',
        author: options.session.userId,
        at: now.toISOString(),
        payload: { absence: report },
      }
      // 転記に成功してから消す。逆にすると書き込み失敗で投函物が失われる。
      await options.storage.put(
        eventPathFor(options.session.groupId, event.id),
        await sealEvent(event, [{ keyId: staffKeyId, key: staffKey }]),
      )
      await discardInboxItem({ storage: options.storage, key: item.key })
      result.absences += 1
      continue
    }

    if (kind === 'email') {
      const registration = parseEmailRegistration(item.body)
      result.pendingContactUpdates.push({
        userId: registration.userId,
        email: registration.email,
      })
      await discardInboxItem({ storage: options.storage, key: item.key })
      result.emails += 1
      continue
    }

    // 判別できないものは消さない。消すと復旧できない。
    result.unknown += 1
  }

  return result
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/inbox/apply.test.ts && npm run typecheck
```

Expected: 14 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/inbox/apply.ts tests/inbox/apply.test.ts
git commit -m "feat(inbox): apply submissions to the event log and collect contact updates"
```

---

### Task 5: 担当者パネル

**Files:**
- Create: `src/ui/StaffPanelView.vue`
- Modify: `src/App.vue`
- Test: `tests/ui/StaffPanelView.test.ts`

**Interfaces:**
- Consumes: Task 2 の `updateContacts` / `loadRosterFile`、Task 4 の `applyInbox`、`publishGrants`、`readStorageSettings`、`Session`、`StorageProvider`、`openGroupDatabase`
- Produces: `StaffPanelView.vue`(props: `session: Session`、`storage: StorageProvider`、`adminPublicKey: Bytes`。emit: `close`)

design 08 のうち、Phase 2d の範囲だけを持つ画面。サブグループ管理と通知設定は Phase 2e/2f。

やることは3つ。

1. **投函枠を配る** — `publishGrants`。これを誰かが押すまで参加者は何も送れない
2. **inbox を処理する** — `applyInbox`。結果の件数を出す
3. **連絡先を名簿へ反映する** — 管理者のときだけ。`pendingContactUpdates` があれば `updateContacts`

**ストレージ資格情報が読めないときは、枠の配布も inbox 処理もできない。** 参加者向けの読み取り専用プロバイダでログインしている場合が該当する。その旨を表示し、ボタンを出さない。

- [ ] **Step 1: 失敗するテストを書く**

`tests/ui/StaffPanelView.test.ts`:

```ts
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/ui/StaffPanelView.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/ui/StaffPanelView.vue"`

- [ ] **Step 3: 実装する**

`src/ui/StaffPanelView.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { Bytes } from '../crypto/bytes'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import type { Session } from '../group/session'
import type { StorageSettings } from '../group/storage-credentials'
import { readStorageSettings } from '../group/storage-credentials'
import { updateContacts } from '../group/roster-update'
import { applyInbox } from '../inbox/apply'
import { publishGrants } from '../inbox/grants'
import type { StorageProvider } from '../storage/provider'

const props = defineProps<{
  session: Session
  storage: StorageProvider
  adminPublicKey: Bytes
}>()
const emit = defineEmits<{ close: [] }>()

const settings = ref<StorageSettings | null>(null)
const loaded = ref(false)
const busy = ref(false)
const error = ref('')
const grantsIssued = ref<number | null>(null)
const appliedAbsences = ref<number | null>(null)
const needsAdmin = ref(false)

onMounted(async () => {
  try {
    settings.value = await readStorageSettings({
      storage: props.storage,
      groupId: props.session.groupId,
      keys: props.session.groupKeys,
    })
  } catch {
    // 参加者向けの読み取り専用プロバイダでは資格情報を読めない
    settings.value = null
  } finally {
    loaded.value = true
  }
})

async function publish(): Promise<void> {
  if (!settings.value) return
  error.value = ''
  busy.value = true
  try {
    const issued = await publishGrants({
      storage: props.storage,
      groupId: props.session.groupId,
      roster: props.session.roster,
      settings: settings.value,
    })
    grantsIssued.value = issued.length
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '投函枠を配れませんでした'
  } finally {
    busy.value = false
  }
}

async function process(): Promise<void> {
  error.value = ''
  needsAdmin.value = false
  busy.value = true
  try {
    const result = await applyInbox({ storage: props.storage, session: props.session })
    appliedAbsences.value = result.absences

    if (result.pendingContactUpdates.length === 0) return

    if (props.session.role !== 'admin') {
      // 名簿の再署名は管理者だけができる(信頼の根を持つのが管理者だけのため)
      needsAdmin.value = true
      return
    }
    const staffKey = props.session.groupKeys.get(keyId(STAFF_SCOPE, 1))
    if (!staffKey) throw new Error('staff スコープ鍵がありません')
    await updateContacts({
      storage: props.storage,
      session: props.session,
      adminPublicKey: props.adminPublicKey,
      staffKey,
      generation: 1,
      updates: result.pendingContactUpdates,
    })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '受信を処理できませんでした'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="loaded">
    <h1>受信と配布</h1>
    <button type="button" data-test="close" @click="emit('close')">閉じる</button>

    <p v-if="!settings" data-test="no-credentials">
      このグループの書き込み設定を読めませんでした。管理者が開設ウィザードで設定するまで、
      投函枠の配布と受信の処理はできません。
    </p>

    <div v-else data-test="ready">
      <button type="button" data-test="publish-grants" :disabled="busy" @click="publish">
        投函枠を配る
      </button>
      <p v-if="grantsIssued !== null" data-test="grants-issued">
        {{ grantsIssued }} 名に配りました
      </p>

      <button type="button" data-test="process-inbox" :disabled="busy" @click="process">
        受信を処理する
      </button>
      <p v-if="appliedAbsences !== null" data-test="applied-absences">
        不在連絡 {{ appliedAbsences }} 件を反映しました
      </p>
      <p v-if="needsAdmin" data-test="needs-admin">
        メールアドレスの登録が届いています。名簿への反映は管理者が行ってください。
      </p>

      <p v-if="error" data-test="error">{{ error }}</p>
    </div>
  </section>
</template>
```

`src/App.vue` に導線を足す。担当者と管理者にだけ出す。

```ts
const panelOpen = ref(false)
```

テンプレートでは `ComposeView` の前後どちらでもよいが、`v-else-if` の連鎖に入れる。

```vue
    <StaffPanelView
      v-else-if="panelOpen"
      :session="session"
      :storage="storage"
      :admin-public-key="adminPublicKey"
      @close="panelOpen = false"
    />
```

`adminPublicKey` は接続コードから来る。`LoginView` が `emit('login', session, connection.root)` を返しているので、`connection.adminPublicKey` も渡すように広げる。

`src/ui/LoginView.vue`:

```ts
const emit = defineEmits<{ login: [session: Session, root: string, adminPublicKey: string] }>()
```

`emit('login', session, connection.root)` を `emit('login', session, connection.root, connection.adminPublicKey)` にする。

`src/App.vue`:

```ts
const adminPublicKey = ref<Bytes>(new Uint8Array(0))

async function onLogin(next: Session, root: string, adminKey: string): Promise<void> {
  session.value = next
  storage.value = new HttpStorageProvider(root)
  adminPublicKey.value = fromBase64(adminKey)
  emailConfirmed.value =
    next.role !== 'member' || (await isEmailConfirmed(openGroupDatabase(next.groupId)))
}
```

`fromBase64` と `Bytes` を import すること。既存の `tests/ui/LoginView.test.ts` が emit の引数を検証している場合は要素が増えるので合わせる。

タイムライン側にボタンを足す。

```vue
      <button
        v-if="session.role !== 'member'"
        data-test="staff-panel"
        @click="panelOpen = true"
      >
        受信と配布
      </button>
```

- [ ] **Step 4: 全体の検証**

```bash
npm run test:run && npm run typecheck && npm run build
```

Expected: すべて成功。

- [ ] **Step 5: コミット**

```bash
git add src/ui/StaffPanelView.vue src/ui/LoginView.vue src/App.vue tests/ui/
git commit -m "feat(ui): add the staff panel for grants and inbox processing"
```

---

## Phase 2d 完了条件

- `npm run test:run` が全て green。**3回連続で通ること**(フレーキーを見逃さないため)
- `npm run typecheck` がエラーなし
- `npm run build` が成功する
- 「参加者が不在連絡を送る → 担当者が処理する → イベントに載る」が Task 4 のテストで通っている
- 名簿の再署名を担当者が試みると拒否される(Task 2)
- 判別できない投函物と開けない投函物が削除されない(Task 4)

## 次フェーズへの引き継ぎ

- 不在連絡の一覧画面。`absences` テーブルに入るところまでは Phase 2d で用意した
- 鍵世代が 1 に固定されている箇所(`keyId(STAFF_SCOPE, 1)`、`updateContacts` の `generation`)。鍵ローテーションを入れる Phase 4 で manifest の `keyringGeneration` から取るように直す
- mailto 通知(受信者解決・テンプレート・BCC バッチ分割) → Phase 2e
- 開設ウィザード・接続確認・リカバリキット → Phase 2f
- サブグループ管理と通知設定 (design 08 の残り) → Phase 2e/2f
