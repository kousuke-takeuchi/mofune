# Phase 2c: 上り経路 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 参加者が不在連絡とメールアドレスを送信でき、担当者がそれを回収して読める状態にする。

**Architecture:** 参加者はストレージの資格情報を持たないため、上りは担当者が発行した期限付き presigned PUT URL への素の PUT で行う。投函物は **staff スコープ鍵ではなく受信者の公開鍵**へ暗号化する(設計書 §4.6。スコープ鍵を参加者に渡すと連絡先一覧まで読めてしまうため)。発行された URL 自体が能力トークンなので、配布物も宛先参加者の公開鍵で暗号化する。

**Tech Stack:** Vue 3 / TypeScript / Vite / Vitest / Dexie.js / Web Crypto API

正は [要件書](../../Mofune%20-%20要件書.md) / [設計書](../../Mofune%20-%20設計書.md)。Phase 1 / 2a / 2b の成果物の上に載る。

## Global Constraints

Phase 1 / 2a / 2b の Global Constraints をすべて引き継ぐ。特に:

- 暗号プリミティブは Web Crypto API のみ。例外は Argon2id (hash-wasm) のみ
- **バイト列の型は `src/crypto/bytes.ts` の `Bytes`**(= `Uint8Array<ArrayBuffer>`)。型注釈上の `Uint8Array` は `Bytes` と読み替える(`new Uint8Array(...)` はそのまま)。テストの `as Bytes` も `as Bytes`
- 秘密鍵・パスワード・ストレージ資格情報を IndexedDB / localStorage に保存してはならない
- ロールは `admin` / `staff` / `member`。UI 表示は管理者 / 担当者 / 参加者
- **参加者からの上りに staff スコープ鍵を使ってはならない**(設計書 §4.6)。受信者の ECDH 公開鍵へ ECIES でラップする
- ストレージパスを組み立てる箇所は `assertSafePath` を通す
- 既読情報を送出してはならない(要件書 §4.10)
- `tsconfig.json` は `strict: true` と `verbatimModuleSyntax: true`
- テストは `tests/**/*.test.ts`。`import { describe, it, expect } from 'vitest'` を明示する
- DOM が要るテストはファイル先頭に `// @vitest-environment happy-dom`
- 非同期が多段になる UI テストでは、固定回数の `flushPromises()` に頼らず `vi.waitFor` で条件待ちする(Phase 2b で繰り返し踏んだ)
- 本番の KDF パラメータをテストで使わない。テストは `TEST_KDF`
- コミットは Conventional Commits 形式。`Co-Authored-By` 行は付けない
- 実行時に外部CDNへ接続しない

## 既存インターフェース(実装前に確認済み)

```ts
// src/crypto/keyring.ts
interface WrappedKey { epk: string; iv: string; ct: string }
wrapKey(recipientEcdhPublic: Bytes, key: CryptoKey): Promise<WrappedKey>
unwrapKey(wrapped: WrappedKey, recipientEcdhPrivate: Bytes): Promise<CryptoKey>
class KeyUnwrapError extends Error {}

// src/crypto/envelope.ts
interface SealTarget { keyId: string; key: CryptoKey }
sealEnvelopeFor(targets: SealTarget[], plaintext: Bytes): Promise<Bytes>
openEnvelope(keys: ReadonlyMap<string, CryptoKey>, bytes: Bytes): Promise<Bytes>
class DecryptionError extends Error {}

// src/crypto/roster.ts
interface RosterMember { userId: string; displayName: string; role: Role; scopes: string[]; ecdhPublic: string; ecdsaPublic: string }
interface RosterContents { groupId: string; generation: number; subgroups: Subgroup[]; members: RosterMember[] }
type Role = 'admin' | 'staff' | 'member'

// src/crypto/symmetric.ts
generateAesKey(): Promise<CryptoKey>
randomBytes(length: number): Bytes

// src/group/session.ts
interface Session { groupId; groupName; userId; displayName; role; scopes; groupKeys; roster; ecdhPrivate; ecdsaPrivate }

// src/group/storage-credentials.ts
interface StorageSettings { provider: 's3'; endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }
readStorageSettings(options: { storage; groupId; keys }): Promise<StorageSettings>
toProviderConfig(settings: StorageSettings): S3ProviderConfig

// src/storage/s3/presign.ts
interface PresignOptions { credentials; region; method: 'GET' | 'PUT'; endpoint: string; path: string; expiresIn: number; now?: Date }
presignUrl(options: PresignOptions): Promise<string>
const MAX_EXPIRES_IN = 604800

// src/storage/paths.ts
inboxPath(groupId: string, userId: string, itemId: string): string   // `${groupId}/inbox/${userId}/${itemId}.enc`

// src/storage/provider.ts
interface StorageProvider { capabilities; get; put; list(prefix, after?); delete }
class NotFoundError extends Error {}

// src/db/group-db.ts
interface OutboxItem { id: string; kind: 'object' | 'event' | 'inbox'; path: string; body: Bytes; queuedAt: string; attempts: number }
openGroupDatabase(groupId: string): GroupDatabase

// src/sync/outbox.ts
enqueue(db, item: Omit<OutboxItem, 'queuedAt' | 'attempts'>): Promise<void>
flushOutbox(options: { db; storage }): Promise<{ sent: number; failed: number }>

// src/sync/events.ts
newEventId(now?: Date): string
```

## File Structure

```
src/inbox/uplink.ts        受信者の公開鍵へ封緘する上り封筒            Task 1
src/inbox/grants.ts        presigned URL の発行と配布                  Task 2
src/inbox/submit.ts        参加者からの投函                            Task 3
src/inbox/collect.ts       担当者による回収                            Task 4
src/content/absence.ts     不在連絡のドメイン                          Task 5
src/group/email-registration.ts  メールアドレス登録のドメイン          Task 6
src/ui/AbsenceView.vue     不在連絡 (design 05)                        Task 7
src/ui/SetupView.vue       初回セットアップ (design 02)                Task 8
src/App.vue                画面遷移の配線(既存を変更)                Task 7-8
```

Task 1-4 が上りの土台、Task 5-6 が中身、Task 7-8 が画面。

---

### Task 1: 受信者の公開鍵へ封緘する上り封筒

**Files:**
- Create: `src/inbox/uplink.ts`
- Test: `tests/inbox/uplink.test.ts`

**Interfaces:**
- Consumes: `Bytes` / `fromBase64` / `toBase64` / `fromUtf8` / `utf8`、`generateAesKey`、`sealEnvelopeFor` / `openEnvelope`、`WrappedKey` / `wrapKey` / `unwrapKey`、`RosterContents` / `RosterMember`
- Produces: `class UplinkFormatError extends Error`、`class NoRecipientError extends Error`、`interface UplinkRecipient { userId: string; ecdhPublic: string }`、`interface UplinkPacket { v: number; keys: Record<string, WrappedKey>; envelope: string }`、`staffRecipients(roster: RosterContents): UplinkRecipient[]` / `sealForRecipients(recipients: UplinkRecipient[], plaintext: Bytes): Promise<Bytes>` / `openAsRecipient(userId: string, ecdhPrivate: Bytes, bytes: Bytes): Promise<Bytes>`

設計書 §4.6 の実装。**参加者は staff スコープ鍵を持たない**ので、上りは受信者の公開鍵へ暗号化する。手順は次のとおり。

```
CEK をランダム生成
  → 本文を CEK で封緘 (sealEnvelopeFor に keyId 'uplink' で渡す)
  → CEK を受信者それぞれの ECDH 公開鍵へ ECIES でラップ (wrapKey)
  → { keys: { userId: WrappedKey, … }, envelope } を JSON にする
```

`staffRecipients` は名簿の公開部から `admin` と `staff` を拾う。名簿の公開部には全員の ECDH 公開鍵があるので、参加者は名簿だけで宛先を解決できる。

受信者が0人になる状況(名簿に担当者がいない)は投函先が無いということなので、黙って捨てず `NoRecipientError` にする。

- [ ] **Step 1: 失敗するテストを書く**

`tests/inbox/uplink.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  NoRecipientError,
  UplinkFormatError,
  openAsRecipient,
  sealForRecipients,
  staffRecipients,
} from '../../src/inbox/uplink'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'
import type { RosterContents } from '../../src/crypto/roster'

async function rosterWith(): Promise<{
  roster: RosterContents
  admin: { userId: string; pair: Awaited<ReturnType<typeof generateEcdhKeyPair>> }
  staff: { userId: string; pair: Awaited<ReturnType<typeof generateEcdhKeyPair>> }
  member: { userId: string; pair: Awaited<ReturnType<typeof generateEcdhKeyPair>> }
}> {
  const admin = { userId: 'u_watanabe', pair: await generateEcdhKeyPair() }
  const staff = { userId: 'u_tanaka', pair: await generateEcdhKeyPair() }
  const member = { userId: 'u_sato', pair: await generateEcdhKeyPair() }
  const roster: RosterContents = {
    groupId: 'midori',
    generation: 1,
    subgroups: [],
    members: [
      {
        userId: admin.userId,
        displayName: '渡辺 けい',
        role: 'admin',
        scopes: ['all', 'staff'],
        ecdhPublic: toBase64(admin.pair.publicKey),
        ecdsaPublic: 'x',
      },
      {
        userId: staff.userId,
        displayName: '田中 みか',
        role: 'staff',
        scopes: ['all', 'staff'],
        ecdhPublic: toBase64(staff.pair.publicKey),
        ecdsaPublic: 'x',
      },
      {
        userId: member.userId,
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: ['all'],
        ecdhPublic: toBase64(member.pair.publicKey),
        ecdsaPublic: 'x',
      },
    ],
  }
  return { roster, admin, staff, member }
}

describe('staffRecipients', () => {
  it('picks admins and staff', async () => {
    const { roster } = await rosterWith()
    expect(staffRecipients(roster).map((r) => r.userId).sort()).toEqual([
      'u_tanaka',
      'u_watanabe',
    ])
  })

  it('never includes a member', async () => {
    const { roster } = await rosterWith()
    expect(staffRecipients(roster).map((r) => r.userId)).not.toContain('u_sato')
  })

  it('returns an empty list when the roster has no staff', async () => {
    const { roster } = await rosterWith()
    const membersOnly = { ...roster, members: roster.members.filter((m) => m.role === 'member') }
    expect(staffRecipients(membersOnly)).toEqual([])
  })
})

describe('sealForRecipients / openAsRecipient', () => {
  it('lets every addressed recipient open it', async () => {
    const { roster, admin, staff } = await rosterWith()
    const sealed = await sealForRecipients(staffRecipients(roster), utf8('体調不良のため欠席します'))
    expect(fromUtf8(await openAsRecipient(admin.userId, admin.pair.privateKey, sealed))).toBe(
      '体調不良のため欠席します',
    )
    expect(fromUtf8(await openAsRecipient(staff.userId, staff.pair.privateKey, sealed))).toBe(
      '体調不良のため欠席します',
    )
  })

  it('cannot be opened by someone who was not addressed', async () => {
    const { roster, member } = await rosterWith()
    const sealed = await sealForRecipients(staffRecipients(roster), utf8('secret'))
    await expect(
      openAsRecipient(member.userId, member.pair.privateKey, sealed),
    ).rejects.toThrow()
  })

  it('cannot be opened with the wrong private key even under the right user id', async () => {
    const { roster, admin } = await rosterWith()
    const stranger = await generateEcdhKeyPair()
    const sealed = await sealForRecipients(staffRecipients(roster), utf8('secret'))
    await expect(
      openAsRecipient(admin.userId, stranger.privateKey, sealed),
    ).rejects.toThrow()
  })

  it('does not leak the plaintext or the recipient public keys', async () => {
    const { roster } = await rosterWith()
    const sealed = await sealForRecipients(staffRecipients(roster), utf8('体調不良'))
    const raw = fromUtf8(sealed)
    expect(raw).not.toContain('体調不良')
    expect(raw).not.toContain(roster.members[0]?.ecdhPublic)
  })

  it('uses a fresh content key for every seal', async () => {
    const { roster } = await rosterWith()
    const a = await sealForRecipients(staffRecipients(roster), utf8('body'))
    const b = await sealForRecipients(staffRecipients(roster), utf8('body'))
    expect(fromUtf8(a)).not.toBe(fromUtf8(b))
  })

  it('refuses to seal with no recipients', async () => {
    await expect(sealForRecipients([], utf8('body'))).rejects.toThrow(NoRecipientError)
  })

  it('rejects bytes that are not an uplink packet', async () => {
    const { admin } = await rosterWith()
    await expect(
      openAsRecipient(admin.userId, admin.pair.privateKey, utf8('{"nope":true}')),
    ).rejects.toThrow(UplinkFormatError)
  })

  it('rejects a packet whose version is unknown', async () => {
    const { roster, admin } = await rosterWith()
    const sealed = await sealForRecipients(staffRecipients(roster), utf8('body'))
    const tampered = utf8(JSON.stringify({ ...JSON.parse(fromUtf8(sealed)), v: 99 }))
    await expect(
      openAsRecipient(admin.userId, admin.pair.privateKey, tampered),
    ).rejects.toThrow(UplinkFormatError)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/inbox/uplink.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/inbox/uplink"`

- [ ] **Step 3: 実装する**

`src/inbox/uplink.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import { fromBase64, fromUtf8, toBase64, utf8 } from '../crypto/bytes'
import { openEnvelope, sealEnvelopeFor } from '../crypto/envelope'
import type { WrappedKey } from '../crypto/keyring'
import { unwrapKey, wrapKey } from '../crypto/keyring'
import type { RosterContents } from '../crypto/roster'
import { generateAesKey } from '../crypto/symmetric'

export class UplinkFormatError extends Error {}
export class NoRecipientError extends Error {}

export const UPLINK_VERSION = 1
/** 本体を包むエンベロープの keyId。CEK は下の keys に入っているので固定でよい。 */
const UPLINK_KEY_ID = 'uplink'

export interface UplinkRecipient {
  userId: string
  /** base64, raw ECDH public key */
  ecdhPublic: string
}

export interface UplinkPacket {
  v: number
  /** userId -> CEK をその人の公開鍵でラップしたもの */
  keys: Record<string, WrappedKey>
  /** base64 のエンベロープ */
  envelope: string
}

/**
 * 名簿の公開部から担当者と管理者を拾う。参加者はここに入らない。
 * 公開部には全員の ECDH 公開鍵があるので、参加者も名簿だけで宛先を解決できる。
 */
export function staffRecipients(roster: RosterContents): UplinkRecipient[] {
  return roster.members
    .filter((member) => member.role === 'admin' || member.role === 'staff')
    .map((member) => ({ userId: member.userId, ecdhPublic: member.ecdhPublic }))
}

/**
 * 受信者それぞれの公開鍵へ封緘する。
 * staff スコープ鍵を使わないのは、参加者にその鍵を渡すと名簿の連絡先まで
 * 復号できてしまうため(設計書 §4.6)。
 */
export async function sealForRecipients(
  recipients: UplinkRecipient[],
  plaintext: Bytes,
): Promise<Bytes> {
  if (recipients.length === 0) {
    throw new NoRecipientError('an uplink needs at least one recipient')
  }
  const cek = await generateAesKey()
  const envelope = await sealEnvelopeFor([{ keyId: UPLINK_KEY_ID, key: cek }], plaintext)

  const keys: Record<string, WrappedKey> = {}
  for (const recipient of recipients) {
    keys[recipient.userId] = await wrapKey(fromBase64(recipient.ecdhPublic), cek)
  }

  const packet: UplinkPacket = {
    v: UPLINK_VERSION,
    keys,
    envelope: toBase64(envelope),
  }
  return utf8(JSON.stringify(packet))
}

export async function openAsRecipient(
  userId: string,
  ecdhPrivate: Bytes,
  bytes: Bytes,
): Promise<Bytes> {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new UplinkFormatError('uplink packet is not valid JSON')
  }
  const packet = parsed as UplinkPacket
  if (packet === null || typeof packet !== 'object' || typeof packet.envelope !== 'string') {
    throw new UplinkFormatError('uplink packet is missing required fields')
  }
  if (packet.v !== UPLINK_VERSION) {
    throw new UplinkFormatError(`unsupported uplink version ${String(packet.v)}`)
  }
  const wrapped = packet.keys?.[userId]
  if (!wrapped) {
    throw new UplinkFormatError(`uplink packet is not addressed to "${userId}"`)
  }
  const cek = await unwrapKey(wrapped, ecdhPrivate)
  return openEnvelope(new Map([[UPLINK_KEY_ID, cek]]), fromBase64(packet.envelope))
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/inbox/uplink.test.ts
npm run typecheck
```

Expected: 11 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/inbox/uplink.ts tests/inbox/uplink.test.ts
git commit -m "feat(inbox): seal uplink packets to recipient public keys"
```

---
### Task 2: presigned URL の発行と配布

**Files:**
- Create: `src/inbox/grants.ts`
- Test: `tests/inbox/grants.test.ts`

**Interfaces:**
- Consumes: Task 1 の `sealForRecipients` / `openAsRecipient` / `UplinkRecipient`、`Bytes` / `toHex` / `fromUtf8` / `utf8`、`randomBytes`、`presignUrl` / `MAX_EXPIRES_IN`、`StorageSettings` / `toProviderConfig`、`RosterContents`、`StorageProvider`、`inboxPath`
- Produces: `class GrantError extends Error`、`interface InboxSlot { key: string; url: string }`、`interface InboxGrant { v: number; issuedAt: string; expiresAt: string; slots: InboxSlot[] }`、`const SLOTS_PER_GRANT` / `const GRANT_TTL_SECONDS`、`grantPath(groupId: string, userId: string): string` / `issueGrant(options: { groupId: string; userId: string; ecdhPublic: string; settings: StorageSettings; now?: Date }): Promise<{ grant: InboxGrant; sealed: Bytes }>` / `publishGrants(options: { storage: StorageProvider; groupId: string; roster: RosterContents; settings: StorageSettings; now?: Date }): Promise<string[]>` / `readGrant(options: { storage: StorageProvider; groupId: string; userId: string; ecdhPrivate: Bytes }): Promise<InboxGrant>`

設計書 §8 の実装。担当者・管理者が開いたときに、各参加者向けの presigned PUT URL をまとめて発行する。

**presigned URL は能力トークンである。** 誰でも読めるストレージに平文で置くと第三者が投函できてしまうので、配布物は必ずその参加者の公開鍵で暗号化する(Task 1 の `sealForRecipients` を宛先1人で使う)。

**1本のURLはキーに固定なので1回しか使えない。** そのため1回の配布で複数本(`SLOTS_PER_GRANT`)渡し、参加者は使い切るまで投函できる。使い切ったら次の配布を待つ。オブジェクトキーはランダム化して、誰がいつ何件投函したかを推測しにくくする。

有効期限は `GRANT_TTL_SECONDS`。担当者がアプリを開くたびに配布し直すので、長すぎる必要はない。

- [ ] **Step 1: 失敗するテストを書く**

`tests/inbox/grants.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  GrantError,
  SLOTS_PER_GRANT,
  grantPath,
  issueGrant,
  publishGrants,
  readGrant,
} from '../../src/inbox/grants'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { toBase64 } from '../../src/crypto/bytes'
import { MemoryStorageProvider } from '../../src/storage/memory'
import type { StorageSettings } from '../../src/group/storage-credentials'
import type { RosterContents } from '../../src/crypto/roster'

const settings: StorageSettings = {
  provider: 's3',
  endpoint: 'https://example.invalid',
  region: 'auto',
  bucket: 'mofune',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
}
const now = new Date('2026-08-08T09:00:00.000Z')

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
  return { roster, member, staff }
}

describe('grantPath', () => {
  it('places the grant inside the user inbox', () => {
    expect(grantPath('midori', 'u_sato')).toBe('midori/inbox/u_sato/grant.enc')
  })
})

describe('issueGrant', () => {
  it('issues several slots so the member can post more than once', async () => {
    const { member } = await fixture()
    const { grant } = await issueGrant({
      groupId: 'midori',
      userId: 'u_sato',
      ecdhPublic: toBase64(member.publicKey),
      settings,
      now,
    })
    expect(grant.slots).toHaveLength(SLOTS_PER_GRANT)
    expect(SLOTS_PER_GRANT).toBeGreaterThan(1)
  })

  it('gives every slot a distinct randomised key under the user inbox', async () => {
    const { member } = await fixture()
    const { grant } = await issueGrant({
      groupId: 'midori',
      userId: 'u_sato',
      ecdhPublic: toBase64(member.publicKey),
      settings,
      now,
    })
    const keys = grant.slots.map((slot) => slot.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) {
      expect(key).toMatch(/^midori\/inbox\/u_sato\/[0-9a-f]{32}\.enc$/)
    }
  })

  it('signs each slot as a PUT url for its own key', async () => {
    const { member } = await fixture()
    const { grant } = await issueGrant({
      groupId: 'midori',
      userId: 'u_sato',
      ecdhPublic: toBase64(member.publicKey),
      settings,
      now,
    })
    for (const slot of grant.slots) {
      const url = new URL(slot.url)
      expect(url.pathname).toBe(`/mofune/${slot.key}`)
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('records when the grant expires', async () => {
    const { member } = await fixture()
    const { grant } = await issueGrant({
      groupId: 'midori',
      userId: 'u_sato',
      ecdhPublic: toBase64(member.publicKey),
      settings,
      now,
    })
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.parse(grant.issuedAt))
  })

  it('seals the grant so only that member can read the urls', async () => {
    const { member, staff } = await fixture()
    const { sealed } = await issueGrant({
      groupId: 'midori',
      userId: 'u_sato',
      ecdhPublic: toBase64(member.publicKey),
      settings,
      now,
    })
    // presigned URL は能力トークンなので、平文で置いてはならない
    expect(new TextDecoder().decode(sealed)).not.toContain('X-Amz-Signature')
    const storage = new MemoryStorageProvider()
    await storage.put(grantPath('midori', 'u_sato'), sealed)
    await expect(
      readGrant({ storage, groupId: 'midori', userId: 'u_tanaka', ecdhPrivate: staff.privateKey }),
    ).rejects.toThrow()
  })
})

describe('publishGrants', () => {
  it('writes one grant per member and none for staff', async () => {
    const { roster } = await fixture()
    const storage = new MemoryStorageProvider()
    const issued = await publishGrants({ storage, groupId: 'midori', roster, settings, now })
    expect(issued).toEqual(['u_sato'])
    expect(await storage.list('midori/inbox/u_sato/')).toHaveLength(1)
    expect(await storage.list('midori/inbox/u_tanaka/')).toHaveLength(0)
  })

  it('lets the member read back their own grant', async () => {
    const { roster, member } = await fixture()
    const storage = new MemoryStorageProvider()
    await publishGrants({ storage, groupId: 'midori', roster, settings, now })
    const grant = await readGrant({
      storage,
      groupId: 'midori',
      userId: 'u_sato',
      ecdhPrivate: member.privateKey,
    })
    expect(grant.slots).toHaveLength(SLOTS_PER_GRANT)
  })

  it('replaces an older grant rather than accumulating', async () => {
    const { roster } = await fixture()
    const storage = new MemoryStorageProvider()
    await publishGrants({ storage, groupId: 'midori', roster, settings, now })
    await publishGrants({ storage, groupId: 'midori', roster, settings, now })
    expect(await storage.list('midori/inbox/u_sato/')).toHaveLength(1)
  })
})

describe('readGrant', () => {
  it('reports a missing grant clearly', async () => {
    const { member } = await fixture()
    await expect(
      readGrant({
        storage: new MemoryStorageProvider(),
        groupId: 'midori',
        userId: 'u_sato',
        ecdhPrivate: member.privateKey,
      }),
    ).rejects.toThrow(GrantError)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/inbox/grants.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/inbox/grants"`

- [ ] **Step 3: 実装する**

`src/inbox/grants.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import { fromUtf8, toHex, utf8 } from '../crypto/bytes'
import type { RosterContents } from '../crypto/roster'
import { randomBytes } from '../crypto/symmetric'
import type { StorageSettings } from '../group/storage-credentials'
import { presignUrl } from '../storage/s3/presign'
import type { StorageProvider } from '../storage/provider'
import { openAsRecipient, sealForRecipients } from './uplink'

export class GrantError extends Error {}

export const GRANT_VERSION = 1
/**
 * 1回の配布で渡す投函枠の数。presigned URL はキーに固定なので1本1回しか使えない。
 * 担当者がアプリを開くたびに配り直すため、数日ぶんあれば足りる。
 */
export const SLOTS_PER_GRANT = 8
/** 枠の有効期限 (秒)。7日。 */
export const GRANT_TTL_SECONDS = 604800

export interface InboxSlot {
  /** 投函先のオブジェクトキー */
  key: string
  /** そのキーへの PUT を許す presigned URL */
  url: string
}

export interface InboxGrant {
  v: number
  issuedAt: string
  expiresAt: string
  slots: InboxSlot[]
}

export function grantPath(groupId: string, userId: string): string {
  return `${groupId}/inbox/${userId}/grant.enc`
}

/**
 * 1人ぶんの投函枠を発行し、その人の公開鍵で封緘する。
 * presigned URL は能力トークンなので、平文でストレージに置いてはならない。
 */
export async function issueGrant(options: {
  groupId: string
  userId: string
  ecdhPublic: string
  settings: StorageSettings
  now?: Date
}): Promise<{ grant: InboxGrant; sealed: Bytes }> {
  const now = options.now ?? new Date()
  const credentials = {
    accessKeyId: options.settings.accessKeyId,
    secretAccessKey: options.settings.secretAccessKey,
  }

  const slots: InboxSlot[] = []
  for (let i = 0; i < SLOTS_PER_GRANT; i += 1) {
    // キーをランダムにして、誰がいつ何件投函したかを推測しにくくする
    const key = `${options.groupId}/inbox/${options.userId}/${toHex(randomBytes(16))}.enc`
    slots.push({
      key,
      url: await presignUrl({
        credentials,
        region: options.settings.region,
        method: 'PUT',
        endpoint: options.settings.endpoint,
        path: `/${options.settings.bucket}/${key}`,
        expiresIn: GRANT_TTL_SECONDS,
        now,
      }),
    })
  }

  const grant: InboxGrant = {
    v: GRANT_VERSION,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + GRANT_TTL_SECONDS * 1000).toISOString(),
    slots,
  }
  const sealed = await sealForRecipients(
    [{ userId: options.userId, ecdhPublic: options.ecdhPublic }],
    utf8(JSON.stringify(grant)),
  )
  return { grant, sealed }
}

/** 参加者全員ぶんの枠を配る。担当者・管理者は資格情報を持つので配らない。 */
export async function publishGrants(options: {
  storage: StorageProvider
  groupId: string
  roster: RosterContents
  settings: StorageSettings
  now?: Date
}): Promise<string[]> {
  const issued: string[] = []
  for (const member of options.roster.members) {
    if (member.role !== 'member') continue
    const { sealed } = await issueGrant({
      groupId: options.groupId,
      userId: member.userId,
      ecdhPublic: member.ecdhPublic,
      settings: options.settings,
      now: options.now,
    })
    await options.storage.put(grantPath(options.groupId, member.userId), sealed)
    issued.push(member.userId)
  }
  return issued
}

export async function readGrant(options: {
  storage: StorageProvider
  groupId: string
  userId: string
  ecdhPrivate: Bytes
}): Promise<InboxGrant> {
  let sealed: Bytes
  try {
    sealed = await options.storage.get(grantPath(options.groupId, options.userId))
  } catch {
    throw new GrantError('no inbox grant has been issued for this user yet')
  }
  const plaintext = await openAsRecipient(options.userId, options.ecdhPrivate, sealed)
  const grant = JSON.parse(fromUtf8(plaintext)) as InboxGrant
  if (grant.v !== GRANT_VERSION || !Array.isArray(grant.slots)) {
    throw new GrantError('inbox grant is malformed')
  }
  return grant
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/inbox/grants.test.ts
npm run typecheck
```

Expected: 10 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/inbox/grants.ts tests/inbox/grants.test.ts
git commit -m "feat(inbox): issue sealed presigned upload grants per member"
```

---

### Task 3: 参加者からの投函

**Files:**
- Create: `src/inbox/submit.ts`
- Test: `tests/inbox/submit.test.ts`

**Interfaces:**
- Consumes: Task 1 の `sealForRecipients` / `staffRecipients`、Task 2 の `InboxGrant` / `InboxSlot` / `readGrant`、`Session`、`GroupDatabase` / `openGroupDatabase`、`enqueue` / `flushOutbox`、`Bytes` / `utf8`
- Produces: `class SubmitError extends Error`、`const USED_SLOTS_KEY`、`usedSlots(db: GroupDatabase): Promise<string[]>` / `nextSlot(grant: InboxGrant, used: string[], now?: Date): InboxSlot` / `submitToInbox(options: { session: Session; db: GroupDatabase; grant: InboxGrant; plaintext: Bytes; now?: Date }): Promise<{ key: string }>`

参加者側の投函。`sealForRecipients(staffRecipients(roster), …)` で担当者・管理者の公開鍵へ封緘し、未使用の枠へ PUT する。

**投函も outbox 経由にする**(要件書 §4.9)。オフラインで書いた不在連絡が消えないようにするため。`OutboxItem.kind` は `'inbox'`、`path` には presigned URL をそのまま入れる。

**使用済みの枠をローカルに記録する。** 同じ URL に二度 PUT すると前の投函を上書きしてしまう。記録は `syncState` ではなく専用のキーに持つ。

期限切れの枠は使わない。全部使い切っている、あるいは全部期限切れなら `SubmitError` にして「担当者がアプリを開くまで待つ」ことを画面で伝えられるようにする。

- [ ] **Step 1: 失敗するテストを書く**

`tests/inbox/submit.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { SubmitError, nextSlot, submitToInbox, usedSlots } from '../../src/inbox/submit'
import type { InboxGrant } from '../../src/inbox/grants'
import { openAsRecipient } from '../../src/inbox/uplink'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { pending } from '../../src/sync/outbox'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

const now = new Date('2026-08-08T09:00:00.000Z')

function grantWith(count: number, expiresAt = '2026-08-15T09:00:00.000Z'): InboxGrant {
  return {
    v: 1,
    issuedAt: '2026-08-08T09:00:00.000Z',
    expiresAt,
    slots: Array.from({ length: count }, (_, i) => ({
      key: `midori/inbox/u_sato/${String(i).padStart(32, '0')}.enc`,
      url: `https://example.invalid/mofune/midori/inbox/u_sato/${i}?X-Amz-Signature=deadbeef`,
    })),
  }
}

async function memberSession(): Promise<{ session: Session; staff: Awaited<ReturnType<typeof generateEcdhKeyPair>> }> {
  const staff = await generateEcdhKeyPair()
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
  return {
    staff,
    session: {
      groupId: 'midori',
      groupName: 'みどり台グループ',
      userId: 'u_sato',
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: ['all'],
      groupKeys: new Map(),
      roster,
      ecdhPrivate: new Uint8Array(0),
      ecdsaPrivate: new Uint8Array(0),
    },
  }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('nextSlot', () => {
  it('returns the first unused slot', () => {
    const grant = grantWith(3)
    expect(nextSlot(grant, [], now).key).toBe(grant.slots[0]?.key)
  })

  it('skips slots that have already been used', () => {
    const grant = grantWith(3)
    const used = [grant.slots[0]?.key as string]
    expect(nextSlot(grant, used, now).key).toBe(grant.slots[1]?.key)
  })

  it('refuses when every slot has been used', () => {
    const grant = grantWith(2)
    const used = grant.slots.map((slot) => slot.key)
    expect(() => nextSlot(grant, used, now)).toThrow(SubmitError)
  })

  it('refuses when the grant has expired', () => {
    const grant = grantWith(3, '2026-08-01T00:00:00.000Z')
    expect(() => nextSlot(grant, [], now)).toThrow(SubmitError)
  })
})

describe('submitToInbox', () => {
  it('queues the sealed packet against an unused slot url', async () => {
    const { session } = await memberSession()
    const db = openGroupDatabase('midori')
    const grant = grantWith(3)
    const result = await submitToInbox({
      session,
      db,
      grant,
      plaintext: utf8('体調不良のため欠席します'),
      now,
    })
    const queued = await pending(db)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.kind).toBe('inbox')
    expect(queued[0]?.path).toBe(grant.slots[0]?.url)
    expect(result.key).toBe(grant.slots[0]?.key)
  })

  it('seals the packet so only staff can open it', async () => {
    const { session, staff } = await memberSession()
    const db = openGroupDatabase('midori')
    await submitToInbox({ session, db, grant: grantWith(1), plaintext: utf8('体調不良'), now })
    const body = (await pending(db))[0]?.body as Bytes
    expect(fromUtf8(body)).not.toContain('体調不良')
    expect(fromUtf8(await openAsRecipient('u_tanaka', staff.privateKey, body))).toBe('体調不良')
  })

  it('records the slot as used so it is never reused', async () => {
    const { session } = await memberSession()
    const db = openGroupDatabase('midori')
    const grant = grantWith(3)
    await submitToInbox({ session, db, grant, plaintext: utf8('one'), now })
    expect(await usedSlots(db)).toEqual([grant.slots[0]?.key])
    await submitToInbox({ session, db, grant, plaintext: utf8('two'), now })
    expect(await usedSlots(db)).toEqual([grant.slots[0]?.key, grant.slots[1]?.key])
  })

  it('never posts twice to the same url', async () => {
    const { session } = await memberSession()
    const db = openGroupDatabase('midori')
    const grant = grantWith(3)
    await submitToInbox({ session, db, grant, plaintext: utf8('one'), now })
    await submitToInbox({ session, db, grant, plaintext: utf8('two'), now })
    const paths = (await pending(db)).map((item) => item.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('refuses once the slots run out', async () => {
    const { session } = await memberSession()
    const db = openGroupDatabase('midori')
    const grant = grantWith(1)
    await submitToInbox({ session, db, grant, plaintext: utf8('one'), now })
    await expect(
      submitToInbox({ session, db, grant, plaintext: utf8('two'), now }),
    ).rejects.toThrow(SubmitError)
  })

  it('refuses when the roster has no staff to receive it', async () => {
    const { session } = await memberSession()
    const noStaff = { ...session, roster: { ...session.roster, members: [] } }
    const db = openGroupDatabase('midori')
    await expect(
      submitToInbox({ session: noStaff, db, grant: grantWith(1), plaintext: utf8('x'), now }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/inbox/submit.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/inbox/submit"`

- [ ] **Step 3: 実装する**

`src/inbox/submit.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import type { GroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import { enqueue } from '../sync/outbox'
import type { InboxGrant, InboxSlot } from './grants'
import { sealForRecipients, staffRecipients } from './uplink'

export class SubmitError extends Error {}

/** 使用済みスロットを記録する syncState のキー。 */
export const USED_SLOTS_KEY = 'usedInboxSlots'

export async function usedSlots(db: GroupDatabase): Promise<string[]> {
  const row = await db.syncState.get(USED_SLOTS_KEY as never)
  if (!row?.value) return []
  try {
    return JSON.parse(row.value) as string[]
  } catch {
    return []
  }
}

/**
 * まだ使っていない枠を1つ返す。
 * 同じ presigned URL に二度 PUT すると前の投函を上書きしてしまうので、
 * 使用済みの記録は必ず参照する。
 */
export function nextSlot(grant: InboxGrant, used: string[], now: Date = new Date()): InboxSlot {
  if (Date.parse(grant.expiresAt) <= now.getTime()) {
    throw new SubmitError('the inbox grant has expired; wait for staff to open the app')
  }
  const free = grant.slots.find((slot) => !used.includes(slot.key))
  if (!free) {
    throw new SubmitError('all inbox slots have been used; wait for staff to open the app')
  }
  return free
}

/**
 * 担当者・管理者の公開鍵へ封緘して投函する。
 * 送信自体は outbox 経由なので、オフラインで書いたものも失われない(要件書 §4.9)。
 */
export async function submitToInbox(options: {
  session: Session
  db: GroupDatabase
  grant: InboxGrant
  plaintext: Bytes
  now?: Date
}): Promise<{ key: string }> {
  const recipients = staffRecipients(options.session.roster)
  const sealed = await sealForRecipients(recipients, options.plaintext)

  const used = await usedSlots(options.db)
  const slot = nextSlot(options.grant, used, options.now)

  await enqueue(options.db, {
    id: slot.key,
    kind: 'inbox',
    // presigned URL をそのまま送信先にする
    path: slot.url,
    body: sealed,
  })
  await options.db.syncState.put({
    key: USED_SLOTS_KEY as never,
    value: JSON.stringify([...used, slot.key]),
  })

  return { key: slot.key }
}
```

`SyncState['key']` は `'cursor' | 'lastReadAt'` のユニオンなので、`USED_SLOTS_KEY` を足す必要がある。`src/db/group-db.ts` を次のように変更し、上の `as never` を消すこと。

```ts
export interface SyncState {
  key: 'cursor' | 'lastReadAt' | 'usedInboxSlots'
  value: string | null
}
```

変更後は `db.syncState.get(USED_SLOTS_KEY)` と `db.syncState.put({ key: USED_SLOTS_KEY, value })` がそのまま通る。**`as never` を残したままにしないこと。** 型を黙らせるだけで、キーの綴り間違いを検出できなくなる。

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/inbox/submit.test.ts
npm run typecheck
```

Expected: 10 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/inbox/submit.ts src/db/group-db.ts tests/inbox/submit.test.ts
git commit -m "feat(inbox): submit sealed uplink packets through granted slots"
```

---

### Task 4: 担当者による回収

**Files:**
- Create: `src/inbox/collect.ts`
- Test: `tests/inbox/collect.test.ts`

**Interfaces:**
- Consumes: Task 1 の `openAsRecipient`、Task 2 の `grantPath`、`Session`、`StorageProvider`、`Bytes` / `fromUtf8`
- Produces: `interface CollectedItem { key: string; body: Bytes }`、`interface CollectResult { items: CollectedItem[]; unreadable: number }`、`collectInbox(options: { storage: StorageProvider; session: Session }): Promise<CollectResult>` / `discardInboxItem(options: { storage: StorageProvider; key: string }): Promise<void>`

担当者・管理者が開いたときに inbox を回収する。

**開けない投函物は正常系である。** 自分が担当者になる前に投函されたもの(当時の担当者の公開鍵にしかラップされていない)は開けない。設計書 §4.6 で受容済みの制約なので、例外にせず `unreadable` として数える。

**grant.enc は回収対象から除く。** これは担当者が置いた配布物であって投函物ではない。

回収したものを events へ転記する処理は Task 5 / 6 の各ドメインが持つ。ここは「読めるものを取り出す」ところまで。

- [ ] **Step 1: 失敗するテストを書く**

`tests/inbox/collect.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { collectInbox, discardInboxItem } from '../../src/inbox/collect'
import { sealForRecipients } from '../../src/inbox/uplink'
import { grantPath } from '../../src/inbox/grants'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

async function fixture() {
  const staff = await generateEcdhKeyPair()
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
    groupKeys: new Map(),
    roster,
    ecdhPrivate: staff.privateKey,
    ecdsaPrivate: new Uint8Array(0),
  }
  return { session, staff, roster }
}

describe('collectInbox', () => {
  it('returns nothing when the inbox is empty', async () => {
    const { session } = await fixture()
    const result = await collectInbox({ storage: new MemoryStorageProvider(), session })
    expect(result).toEqual({ items: [], unreadable: 0 })
  })

  it('reads every packet addressed to this staff member', async () => {
    const { session, roster } = await fixture()
    const storage = new MemoryStorageProvider()
    const recipients = [
      { userId: 'u_tanaka', ecdhPublic: roster.members[0]?.ecdhPublic as string },
    ]
    await storage.put(
      'midori/inbox/u_sato/aaaa.enc',
      await sealForRecipients(recipients, utf8('体調不良のため欠席します')),
    )
    const result = await collectInbox({ storage, session })
    expect(result.items).toHaveLength(1)
    expect(fromUtf8(result.items[0]?.body as Bytes)).toBe('体調不良のため欠席します')
    expect(result.items[0]?.key).toBe('midori/inbox/u_sato/aaaa.enc')
  })

  it('collects across several members', async () => {
    const { session, roster } = await fixture()
    const storage = new MemoryStorageProvider()
    const recipients = [
      { userId: 'u_tanaka', ecdhPublic: roster.members[0]?.ecdhPublic as string },
    ]
    await storage.put('midori/inbox/u_sato/a.enc', await sealForRecipients(recipients, utf8('a')))
    await storage.put('midori/inbox/u_mori/b.enc', await sealForRecipients(recipients, utf8('b')))
    const result = await collectInbox({ storage, session })
    expect(result.items.map((item) => fromUtf8(item.body)).sort()).toEqual(['a', 'b'])
  })

  it('skips the grant object, which is not a submission', async () => {
    const { session, roster } = await fixture()
    const storage = new MemoryStorageProvider()
    const recipients = [
      { userId: 'u_tanaka', ecdhPublic: roster.members[0]?.ecdhPublic as string },
    ]
    await storage.put(grantPath('midori', 'u_sato'), await sealForRecipients(recipients, utf8('grant')))
    await storage.put('midori/inbox/u_sato/a.enc', await sealForRecipients(recipients, utf8('a')))
    const result = await collectInbox({ storage, session })
    expect(result.items).toHaveLength(1)
    expect(fromUtf8(result.items[0]?.body as Bytes)).toBe('a')
  })

  it('counts packets it cannot open instead of failing', async () => {
    const { session } = await fixture()
    const storage = new MemoryStorageProvider()
    const other = await generateEcdhKeyPair()
    await storage.put(
      'midori/inbox/u_sato/a.enc',
      await sealForRecipients(
        [{ userId: 'u_former', ecdhPublic: toBase64(other.publicKey) }],
        utf8('older submission'),
      ),
    )
    const result = await collectInbox({ storage, session })
    expect(result.items).toHaveLength(0)
    expect(result.unreadable).toBe(1)
  })

  it('counts garbage objects as unreadable rather than throwing', async () => {
    const { session } = await fixture()
    const storage = new MemoryStorageProvider()
    await storage.put('midori/inbox/u_sato/a.enc', utf8('not a packet'))
    const result = await collectInbox({ storage, session })
    expect(result.unreadable).toBe(1)
  })
})

describe('discardInboxItem', () => {
  it('removes a processed submission', async () => {
    const { session, roster } = await fixture()
    const storage = new MemoryStorageProvider()
    const recipients = [
      { userId: 'u_tanaka', ecdhPublic: roster.members[0]?.ecdhPublic as string },
    ]
    await storage.put('midori/inbox/u_sato/a.enc', await sealForRecipients(recipients, utf8('a')))
    await discardInboxItem({ storage, key: 'midori/inbox/u_sato/a.enc' })
    expect((await collectInbox({ storage, session })).items).toHaveLength(0)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/inbox/collect.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/inbox/collect"`

- [ ] **Step 3: 実装する**

`src/inbox/collect.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import type { Session } from '../group/session'
import type { StorageProvider } from '../storage/provider'
import { openAsRecipient } from './uplink'

export interface CollectedItem {
  /** ストレージ上のキー。処理後に discardInboxItem へ渡す。 */
  key: string
  body: Bytes
}

export interface CollectResult {
  items: CollectedItem[]
  /** 自分の鍵では開けなかった投函物の数。異常ではない(設計書 §4.6)。 */
  unreadable: number
}

/** 担当者が置いた配布物であって、投函物ではない。 */
function isGrant(key: string): boolean {
  return key.endsWith('/grant.enc')
}

export async function collectInbox(options: {
  storage: StorageProvider
  session: Session
}): Promise<CollectResult> {
  const entries = await options.storage.list(`${options.session.groupId}/inbox/`)
  const items: CollectedItem[] = []
  let unreadable = 0

  for (const entry of entries) {
    if (isGrant(entry.path)) continue
    try {
      const sealed = await options.storage.get(entry.path)
      const body = await openAsRecipient(
        options.session.userId,
        options.session.ecdhPrivate,
        sealed,
      )
      items.push({ key: entry.path, body })
    } catch {
      // 自分が担当者になる前の投函物は開けない。受容済みの制約。
      unreadable += 1
    }
  }

  return { items, unreadable }
}

export async function discardInboxItem(options: {
  storage: StorageProvider
  key: string
}): Promise<void> {
  await options.storage.delete(options.key)
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/inbox/collect.test.ts
npm run typecheck
```

Expected: 7 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/inbox/collect.ts tests/inbox/collect.test.ts
git commit -m "feat(inbox): collect readable submissions for staff"
```

---
### Task 5: 不在連絡のドメイン

**Files:**
- Create: `src/content/absence.ts`
- Test: `tests/content/absence.test.ts`

**Interfaces:**
- Consumes: Task 3 の `submitToInbox`、`Session`、`GroupDatabase`、`Bytes` / `fromUtf8` / `toHex` / `utf8`、`randomBytes`、`InboxGrant`
- Produces: `class AbsenceError extends Error`、`type AbsenceKind = 'absent' | 'late' | 'early'`、`const ABSENCE_KINDS` / `const DEFAULT_REASONS`、`interface AbsenceReport { id: string; kind: AbsenceKind; date: string; reason: string; note: string; author: string; at: string }`、`newAbsenceId(): string` / `buildAbsenceReport(options: { session: Session; kind: AbsenceKind; date: string; reason: string; note: string; now?: Date }): AbsenceReport` / `parseAbsenceReport(bytes: Bytes): AbsenceReport` / `sendAbsenceReport(options: { session: Session; db: GroupDatabase; grant: InboxGrant; report: AbsenceReport; now?: Date }): Promise<{ key: string }>`

要件書 §4.4 と design 05 の実装。

- 種別は「欠席 / 遅れます / 早く帰ります」の3つ(`absent` / `late` / `early`)
- 対象日を指定する(`YYYY-MM-DD`)
- よく使う理由を定型選択肢から選べる。**今フェーズでは `DEFAULT_REASONS` を定数に置く。** グループ設定(`settings/templates.enc`)からの読み込みは Phase 2d
- 自由記述の「ひとこと」を添えられる

宛先は担当者・管理者全員。Task 3 が公開鍵へ封緘するので、ここは中身の組み立てと検証だけを持つ。

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/absence.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  ABSENCE_KINDS,
  AbsenceError,
  DEFAULT_REASONS,
  buildAbsenceReport,
  newAbsenceId,
  parseAbsenceReport,
  sendAbsenceReport,
} from '../../src/content/absence'
import type { InboxGrant } from '../../src/inbox/grants'
import { openAsRecipient } from '../../src/inbox/uplink'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { pending } from '../../src/sync/outbox'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

const now = new Date('2026-08-08T07:30:00.000Z')

const grant: InboxGrant = {
  v: 1,
  issuedAt: '2026-08-08T00:00:00.000Z',
  expiresAt: '2026-08-15T00:00:00.000Z',
  slots: [
    { key: 'midori/inbox/u_sato/a.enc', url: 'https://example.invalid/a?X-Amz-Signature=x' },
    { key: 'midori/inbox/u_sato/b.enc', url: 'https://example.invalid/b?X-Amz-Signature=x' },
  ],
}

async function memberSession() {
  const staff = await generateEcdhKeyPair()
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
    userId: 'u_sato',
    displayName: '佐藤 さくら',
    role: 'member',
    scopes: ['all'],
    groupKeys: new Map(),
    roster,
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
  return { session, staff }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('absence vocabulary', () => {
  it('offers exactly the three kinds the requirements name', () => {
    expect(ABSENCE_KINDS).toEqual(['absent', 'late', 'early'])
  })

  it('ships a starting set of common reasons', () => {
    expect(DEFAULT_REASONS.length).toBeGreaterThan(0)
    expect(DEFAULT_REASONS).toContain('体調不良')
  })
})

describe('newAbsenceId', () => {
  it('is a random hex id', () => {
    expect(newAbsenceId()).toMatch(/^ab_[0-9a-f]{32}$/)
  })
})

describe('buildAbsenceReport', () => {
  it('records the kind, date, reason and note', async () => {
    const { session } = await memberSession()
    const report = buildAbsenceReport({
      session,
      kind: 'absent',
      date: '2026-08-08',
      reason: '体調不良',
      note: '朝から熱があるため、本日はお休みします。',
      now,
    })
    expect(report.kind).toBe('absent')
    expect(report.date).toBe('2026-08-08')
    expect(report.reason).toBe('体調不良')
    expect(report.note).toBe('朝から熱があるため、本日はお休みします。')
    expect(report.author).toBe('u_sato')
    expect(report.at).toBe('2026-08-08T07:30:00.000Z')
  })

  it('rejects a date that is not YYYY-MM-DD', async () => {
    const { session } = await memberSession()
    expect(() =>
      buildAbsenceReport({ session, kind: 'absent', date: '8/8', reason: '', note: '', now }),
    ).toThrow(AbsenceError)
  })

  it('rejects an unknown kind', async () => {
    const { session } = await memberSession()
    expect(() =>
      buildAbsenceReport({
        session,
        kind: 'holiday' as never,
        date: '2026-08-08',
        reason: '',
        note: '',
        now,
      }),
    ).toThrow(AbsenceError)
  })

  it('allows an empty reason and note', async () => {
    const { session } = await memberSession()
    const report = buildAbsenceReport({
      session,
      kind: 'late',
      date: '2026-08-08',
      reason: '',
      note: '',
      now,
    })
    expect(report.reason).toBe('')
    expect(report.note).toBe('')
  })
})

describe('sendAbsenceReport', () => {
  it('queues a packet only staff can read', async () => {
    const { session, staff } = await memberSession()
    const db = openGroupDatabase('midori')
    const report = buildAbsenceReport({
      session,
      kind: 'absent',
      date: '2026-08-08',
      reason: '体調不良',
      note: '朝から熱があります',
      now,
    })
    await sendAbsenceReport({ session, db, grant, report, now })

    const queued = await pending(db)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.kind).toBe('inbox')
    const body = queued[0]?.body as Bytes
    expect(fromUtf8(body)).not.toContain('体調不良')

    const opened = parseAbsenceReport(
      await openAsRecipient('u_tanaka', staff.privateKey, body),
    )
    expect(opened.reason).toBe('体調不良')
    expect(opened.note).toBe('朝から熱があります')
    expect(opened.author).toBe('u_sato')
  })

  it('round-trips through parseAbsenceReport', async () => {
    const { session } = await memberSession()
    const report = buildAbsenceReport({
      session,
      kind: 'early',
      date: '2026-08-09',
      reason: '通院',
      note: '',
      now,
    })
    expect(parseAbsenceReport(utf8(JSON.stringify(report)))).toEqual(report)
  })

  it('rejects bytes that are not an absence report', () => {
    expect(() => parseAbsenceReport(utf8('{"nope":true}'))).toThrow(AbsenceError)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/content/absence.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/content/absence"`

- [ ] **Step 3: 実装する**

`src/content/absence.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import { fromUtf8, toHex, utf8 } from '../crypto/bytes'
import { randomBytes } from '../crypto/symmetric'
import type { GroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import type { InboxGrant } from '../inbox/grants'
import { submitToInbox } from '../inbox/submit'

export class AbsenceError extends Error {}

export type AbsenceKind = 'absent' | 'late' | 'early'

/** design 05 の「欠席 / 遅れます / 早く帰ります」。 */
export const ABSENCE_KINDS: readonly AbsenceKind[] = ['absent', 'late', 'early']

/**
 * よく使う理由の初期値。Phase 2d でグループ設定 (settings/templates.enc) から
 * 読み込めるようにするまでの暫定。
 */
export const DEFAULT_REASONS: readonly string[] = ['体調不良', '通院', '家庭の都合']

export interface AbsenceReport {
  id: string
  kind: AbsenceKind
  /** YYYY-MM-DD */
  date: string
  reason: string
  note: string
  author: string
  at: string
}

export function newAbsenceId(): string {
  return `ab_${toHex(randomBytes(16))}`
}

export function buildAbsenceReport(options: {
  session: Session
  kind: AbsenceKind
  date: string
  reason: string
  note: string
  now?: Date
}): AbsenceReport {
  if (!ABSENCE_KINDS.includes(options.kind)) {
    throw new AbsenceError(`unknown absence kind "${String(options.kind)}"`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new AbsenceError(`date must be YYYY-MM-DD, got "${options.date}"`)
  }
  const now = options.now ?? new Date()
  return {
    id: newAbsenceId(),
    kind: options.kind,
    date: options.date,
    reason: options.reason,
    note: options.note,
    author: options.session.userId,
    at: now.toISOString(),
  }
}

export function parseAbsenceReport(bytes: Bytes): AbsenceReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new AbsenceError('absence report is not valid JSON')
  }
  const report = parsed as AbsenceReport
  if (
    report === null ||
    typeof report !== 'object' ||
    typeof report.id !== 'string' ||
    typeof report.date !== 'string' ||
    typeof report.author !== 'string' ||
    !ABSENCE_KINDS.includes(report.kind)
  ) {
    throw new AbsenceError('absence report is missing required fields')
  }
  return report
}

/** 宛先は担当者・管理者の全員。封緘は submitToInbox が受け持つ。 */
export async function sendAbsenceReport(options: {
  session: Session
  db: GroupDatabase
  grant: InboxGrant
  report: AbsenceReport
  now?: Date
}): Promise<{ key: string }> {
  return submitToInbox({
    session: options.session,
    db: options.db,
    grant: options.grant,
    plaintext: utf8(JSON.stringify(options.report)),
    now: options.now,
  })
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/content/absence.test.ts
npm run typecheck
```

Expected: 10 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/content/absence.ts tests/content/absence.test.ts
git commit -m "feat(content): add absence reports addressed to staff"
```

---

### Task 6: メールアドレス登録のドメイン

**Files:**
- Create: `src/group/email-registration.ts`
- Test: `tests/group/email-registration.test.ts`

**Interfaces:**
- Consumes: Task 3 の `submitToInbox`、`Session`、`GroupDatabase`、`Bytes` / `fromUtf8` / `utf8`、`InboxGrant`
- Produces: `class EmailRegistrationError extends Error`、`interface EmailRegistration { v: number; userId: string; email: string; at: string }`、`const EMAIL_CONFIRMED_KEY`、`isPlausibleEmail(text: string): boolean` / `buildEmailRegistration(options: { session: Session; email: string; now?: Date }): EmailRegistration` / `parseEmailRegistration(bytes: Bytes): EmailRegistration` / `sendEmailRegistration(options: { session: Session; db: GroupDatabase; grant: InboxGrant; registration: EmailRegistration; now?: Date }): Promise<{ key: string }>` / `markEmailConfirmed(db: GroupDatabase): Promise<void>` / `isEmailConfirmed(db: GroupDatabase): Promise<boolean>`

要件書 §4.6 と design 02 の実装。メールアドレス登録を入会の必須条件とし、未登録の間は主要機能をロックする。

**メールアドレスは連絡先なので、参加者どうしには見えてはならない**(要件書 §5.3)。Task 3 の経路で担当者・管理者の公開鍵へ封緘する。名簿の staff 部への反映は担当者側の作業(Phase 2d の名簿更新でつなぐ)。

**到達確認の完了フラグは端末ローカルに持つ。** design 02 の「テスト通知が届きました」は本人がボタンを押して申告するもので、機械的な検証はできない(要件書 §6-2 と同じ性質)。ここではローカルのロック解除フラグとして扱う。

メールアドレスの検証は**形式のごく粗いチェックに留める。** 厳密な正規表現は正しいアドレスを弾く事故のほうが多い。到達性は実際にテスト通知を送って本人が確認する運用で担保する。

- [ ] **Step 1: 失敗するテストを書く**

`tests/group/email-registration.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  EmailRegistrationError,
  buildEmailRegistration,
  isEmailConfirmed,
  isPlausibleEmail,
  markEmailConfirmed,
  parseEmailRegistration,
  sendEmailRegistration,
} from '../../src/group/email-registration'
import type { InboxGrant } from '../../src/inbox/grants'
import { openAsRecipient } from '../../src/inbox/uplink'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { pending } from '../../src/sync/outbox'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

const now = new Date('2026-08-08T09:00:00.000Z')

const grant: InboxGrant = {
  v: 1,
  issuedAt: '2026-08-08T00:00:00.000Z',
  expiresAt: '2026-08-15T00:00:00.000Z',
  slots: [{ key: 'midori/inbox/u_sato/a.enc', url: 'https://example.invalid/a?X-Amz-Signature=x' }],
}

async function memberSession() {
  const staff = await generateEcdhKeyPair()
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
    userId: 'u_sato',
    displayName: '佐藤 さくら',
    role: 'member',
    scopes: ['all'],
    groupKeys: new Map(),
    roster,
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
  return { session, staff }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('isPlausibleEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isPlausibleEmail('sakura@example.com')).toBe(true)
    expect(isPlausibleEmail('sakura.h+mofune@example.co.jp')).toBe(true)
  })

  it('rejects text with no at sign or no dot in the domain', () => {
    expect(isPlausibleEmail('sakura')).toBe(false)
    expect(isPlausibleEmail('sakura@example')).toBe(false)
  })

  it('rejects whitespace and empty input', () => {
    expect(isPlausibleEmail('')).toBe(false)
    expect(isPlausibleEmail('a b@example.com')).toBe(false)
  })
})

describe('buildEmailRegistration', () => {
  it('records the address against the signed-in user', async () => {
    const { session } = await memberSession()
    const registration = buildEmailRegistration({
      session,
      email: 'sakura@example.com',
      now,
    })
    expect(registration.userId).toBe('u_sato')
    expect(registration.email).toBe('sakura@example.com')
    expect(registration.at).toBe('2026-08-08T09:00:00.000Z')
  })

  it('trims surrounding whitespace', async () => {
    const { session } = await memberSession()
    expect(
      buildEmailRegistration({ session, email: '  sakura@example.com  ', now }).email,
    ).toBe('sakura@example.com')
  })

  it('refuses an implausible address', async () => {
    const { session } = await memberSession()
    expect(() => buildEmailRegistration({ session, email: 'sakura', now })).toThrow(
      EmailRegistrationError,
    )
  })
})

describe('sendEmailRegistration', () => {
  it('queues a packet only staff can read', async () => {
    const { session, staff } = await memberSession()
    const db = openGroupDatabase('midori')
    const registration = buildEmailRegistration({ session, email: 'sakura@example.com', now })
    await sendEmailRegistration({ session, db, grant, registration, now })

    const queued = await pending(db)
    expect(queued).toHaveLength(1)
    const body = queued[0]?.body as Bytes
    // 連絡先は参加者どうしに見えてはならない(要件書 §5.3)
    expect(fromUtf8(body)).not.toContain('sakura@example.com')

    const opened = parseEmailRegistration(
      await openAsRecipient('u_tanaka', staff.privateKey, body),
    )
    expect(opened.email).toBe('sakura@example.com')
  })

  it('rejects bytes that are not a registration', () => {
    expect(() => parseEmailRegistration(utf8('{"nope":true}'))).toThrow(EmailRegistrationError)
  })
})

describe('confirmation flag', () => {
  it('starts unconfirmed', async () => {
    expect(await isEmailConfirmed(openGroupDatabase('midori'))).toBe(false)
  })

  it('is set once the user says the test notice arrived', async () => {
    const db = openGroupDatabase('midori')
    await markEmailConfirmed(db)
    expect(await isEmailConfirmed(db)).toBe(true)
  })

  it('survives reopening the database', async () => {
    await markEmailConfirmed(openGroupDatabase('midori'))
    expect(await isEmailConfirmed(openGroupDatabase('midori'))).toBe(true)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/group/email-registration.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/group/email-registration"`

- [ ] **Step 3: 実装する**

まず `src/db/group-db.ts` の `SyncState['key']` に `emailConfirmed` を足す。

```ts
export interface SyncState {
  key: 'cursor' | 'lastReadAt' | 'usedInboxSlots' | 'emailConfirmed'
  value: string | null
}
```

`src/group/email-registration.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import { fromUtf8, utf8 } from '../crypto/bytes'
import type { GroupDatabase } from '../db/group-db'
import type { InboxGrant } from '../inbox/grants'
import { submitToInbox } from '../inbox/submit'
import type { Session } from './session'

export class EmailRegistrationError extends Error {}

export const EMAIL_REGISTRATION_VERSION = 1
export const EMAIL_CONFIRMED_KEY = 'emailConfirmed' as const

export interface EmailRegistration {
  v: number
  userId: string
  email: string
  at: string
}

/**
 * 形式のごく粗いチェックだけを行う。厳密な正規表現は、正しいアドレスを
 * 弾いてしまう事故のほうが多い。到達性はテスト通知を送って本人が確認する
 * 運用で担保する(要件書 §4.6)。
 */
export function isPlausibleEmail(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false
  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return false
  const domain = trimmed.slice(at + 1)
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')
}

export function buildEmailRegistration(options: {
  session: Session
  email: string
  now?: Date
}): EmailRegistration {
  const email = options.email.trim()
  if (!isPlausibleEmail(email)) {
    throw new EmailRegistrationError(`"${options.email}" does not look like an email address`)
  }
  return {
    v: EMAIL_REGISTRATION_VERSION,
    userId: options.session.userId,
    email,
    at: (options.now ?? new Date()).toISOString(),
  }
}

export function parseEmailRegistration(bytes: Bytes): EmailRegistration {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new EmailRegistrationError('registration is not valid JSON')
  }
  const registration = parsed as EmailRegistration
  if (
    registration === null ||
    typeof registration !== 'object' ||
    typeof registration.userId !== 'string' ||
    typeof registration.email !== 'string' ||
    registration.v !== EMAIL_REGISTRATION_VERSION
  ) {
    throw new EmailRegistrationError('registration is missing required fields')
  }
  return registration
}

export async function sendEmailRegistration(options: {
  session: Session
  db: GroupDatabase
  grant: InboxGrant
  registration: EmailRegistration
  now?: Date
}): Promise<{ key: string }> {
  return submitToInbox({
    session: options.session,
    db: options.db,
    grant: options.grant,
    plaintext: utf8(JSON.stringify(options.registration)),
    now: options.now,
  })
}

/**
 * 到達確認は本人の自己申告(design 02)。機械的な検証はできないので、
 * 端末ローカルのロック解除フラグとして扱う。
 */
export async function markEmailConfirmed(db: GroupDatabase): Promise<void> {
  await db.syncState.put({ key: EMAIL_CONFIRMED_KEY, value: new Date().toISOString() })
}

export async function isEmailConfirmed(db: GroupDatabase): Promise<boolean> {
  return Boolean((await db.syncState.get(EMAIL_CONFIRMED_KEY))?.value)
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/group/email-registration.test.ts
npm run typecheck
```

Expected: 11 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/group/email-registration.ts src/db/group-db.ts tests/group/email-registration.test.ts
git commit -m "feat(group): register member email addresses through the inbox"
```

---

### Task 7: 不在連絡画面 (design 05)

**Files:**
- Create: `src/ui/AbsenceView.vue`
- Modify: `src/App.vue`
- Test: `tests/ui/AbsenceView.test.ts`

**Interfaces:**
- Consumes: Task 5 の `ABSENCE_KINDS` / `DEFAULT_REASONS` / `buildAbsenceReport` / `sendAbsenceReport`、Task 2 の `readGrant`、`Session`、`openGroupDatabase`、`flushOutbox`、`StorageProvider`
- Produces: `AbsenceView.vue`(props: `session: Session`、`storage: StorageProvider`。emit: `sent`、`cancel`)

design 05 の画面。日付(今日/明日)、種別3つ、定型理由、ひとこと。

**枠が無いときは正直に伝える。** grant が無い・期限切れ・使い切りのいずれでも送信できないので、「担当者がアプリを開くまで待つ必要がある」と表示する。黙って失敗させない。

**非同期の待ちは `vi.waitFor` で条件待ちする**(Global Constraints)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/ui/AbsenceView.test.ts`:

```ts
// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import AbsenceView from '../../src/ui/AbsenceView.vue'
import { issueGrant, grantPath } from '../../src/inbox/grants'
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
  await deleteGroupDatabase('midori')
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

async function mountAbsence(storage: MemoryStorageProvider, session: Session) {
  const wrapper = mount(AbsenceView, { props: { session, storage } })
  mounted.push(wrapper)
  await vi.waitFor(() => {
    if (!wrapper.find('[data-test="ready"]').exists() && !wrapper.find('[data-test="no-slots"]').exists()) {
      throw new Error('still loading')
    }
  }, { timeout: 2000, interval: 10 })
  return wrapper
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
    await wrapper.find('[data-test="kind"][data-kind="absent"]').trigger('click')
    await wrapper.find('[data-test="note"]').setValue('朝から熱があります')
    await wrapper.find('[data-test="submit"]').trigger('click')
    await vi.waitFor(async () => {
      if ((await pending(openGroupDatabase('midori'))).length === 0 && !wrapper.emitted('sent')) {
        throw new Error('not sent')
      }
    }, { timeout: 2000, interval: 10 })
    expect(wrapper.emitted('sent')).toBeTruthy()
  })

  it('tells the user when no slots are available', async () => {
    const { session } = await fixture()
    // grant が置かれていないストレージ
    const wrapper = await mountAbsence(new MemoryStorageProvider(), session)
    expect(wrapper.find('[data-test="no-slots"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="submit"]').exists()).toBe(false)
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/ui/AbsenceView.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/ui/AbsenceView.vue"`

- [ ] **Step 3: 実装する**

`src/ui/AbsenceView.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AbsenceKind } from '../content/absence'
import { ABSENCE_KINDS, DEFAULT_REASONS, buildAbsenceReport, sendAbsenceReport } from '../content/absence'
import { openGroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import type { InboxGrant } from '../inbox/grants'
import { readGrant } from '../inbox/grants'
import type { StorageProvider } from '../storage/provider'
import { flushOutbox } from '../sync/outbox'

const props = defineProps<{ session: Session; storage: StorageProvider }>()
const emit = defineEmits<{ sent: []; cancel: [] }>()

const KIND_LABELS: Record<AbsenceKind, string> = {
  absent: '欠席',
  late: '遅れます',
  early: '早く帰ります',
}

const grant = ref<InboxGrant | null>(null)
const loaded = ref(false)
const kind = ref<AbsenceKind>('absent')
const date = ref(new Date().toISOString().slice(0, 10))
const reason = ref('')
const note = ref('')
const error = ref('')
const queued = ref(false)
const busy = ref(false)

const db = openGroupDatabase(props.session.groupId)

onMounted(async () => {
  try {
    grant.value = await readGrant({
      storage: props.storage,
      groupId: props.session.groupId,
      userId: props.session.userId,
      ecdhPrivate: props.session.ecdhPrivate,
    })
  } catch {
    grant.value = null
  } finally {
    loaded.value = true
  }
})

async function submit(): Promise<void> {
  if (!grant.value) return
  error.value = ''
  queued.value = false
  busy.value = true
  try {
    const report = buildAbsenceReport({
      session: props.session,
      kind: kind.value,
      date: date.value,
      reason: reason.value,
      note: note.value,
    })
    await sendAbsenceReport({ session: props.session, db, grant: grant.value, report })
    const flushed = await flushOutbox({ db, storage: props.storage })
    if (flushed.failed > 0) {
      queued.value = true
    } else {
      emit('sent')
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '送信できませんでした'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="loaded">
    <h1>欠席・不在をつたえる</h1>

    <p v-if="!grant" data-test="no-slots">
      いまは送信できません。担当者がアプリを開くと送信枠が用意されます。
    </p>

    <div v-else data-test="ready">
      <fieldset>
        <legend>どの日ですか</legend>
        <input type="date" data-test="date" v-model="date" />
      </fieldset>

      <fieldset>
        <legend>種類</legend>
        <button
          v-for="value in ABSENCE_KINDS"
          :key="value"
          type="button"
          data-test="kind"
          :data-kind="value"
          :aria-pressed="kind === value"
          @click="kind = value"
        >
          {{ KIND_LABELS[value] }}
        </button>
      </fieldset>

      <fieldset>
        <legend>理由(よく使うものから)</legend>
        <button
          v-for="value in DEFAULT_REASONS"
          :key="value"
          type="button"
          data-test="reason"
          :aria-pressed="reason === value"
          @click="reason = value"
        >
          {{ value }}
        </button>
      </fieldset>

      <label>
        ひとこと
        <textarea data-test="note" v-model="note"></textarea>
      </label>

      <p>この内容は宛先の担当者だけが読めます</p>

      <p v-if="error" data-test="error">{{ error }}</p>
      <p v-if="queued" data-test="queued">
        オフラインのため送信待ちにしました。オンラインに戻ると自動で送信されます。
      </p>

      <button type="button" data-test="cancel" @click="emit('cancel')">キャンセル</button>
      <button type="button" data-test="submit" :disabled="busy" @click="submit">送信する</button>
    </div>
  </section>
</template>
```

`src/App.vue` に不在連絡への導線を足す。参加者にも担当者にも出す(要件書 §3 で不在連絡は全ロールが行える)。

```vue
    <AbsenceView
      v-else-if="reporting"
      :session="session"
      :storage="storage"
      @sent="reporting = false"
      @cancel="reporting = false"
    />
```

とし、タイムライン側に `<button data-test="report" @click="reporting = true">れんらく</button>` を置く。`const reporting = ref(false)` を script に足すこと。

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/ui/
npm run typecheck
```

Expected: AbsenceView 6 tests が green、既存の UI テストも green。

- [ ] **Step 5: コミット**

```bash
git add src/ui/AbsenceView.vue src/App.vue tests/ui/AbsenceView.test.ts
git commit -m "feat(ui): add the absence report screen"
```

---

### Task 8: 初回セットアップ画面 (design 02)

**Files:**
- Create: `src/ui/SetupView.vue`
- Modify: `src/App.vue`
- Test: `tests/ui/SetupView.test.ts`

**Interfaces:**
- Consumes: Task 6 の `buildEmailRegistration` / `sendEmailRegistration` / `isPlausibleEmail` / `markEmailConfirmed` / `isEmailConfirmed`、Task 2 の `readGrant`、`Session`、`openGroupDatabase`、`flushOutbox`、`StorageProvider`
- Produces: `SetupView.vue`(props: `session: Session`、`storage: StorageProvider`。emit: `done`)

design 02 の画面。メールアドレスを登録し、到達確認を本人が申告してロックを解除する。

**未登録の間は主要機能をロックする**(要件書 §4.6)。`App.vue` で、参加者かつ `isEmailConfirmed` が偽ならこの画面を出す。

到達確認は本人の自己申告であり、機械的な検証はできない。画面の文言もそのように書く(「テスト通知が届いたら押してください」)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/ui/SetupView.test.ts`:

```ts
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

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

async function mountSetup() {
  const { session, storage } = await fixture()
  const wrapper = mount(SetupView, { props: { session, storage } })
  mounted.push(wrapper)
  await vi.waitFor(() => {
    if (!wrapper.find('[data-test="email"]').exists()) throw new Error('still loading')
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/ui/SetupView.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/ui/SetupView.vue"`

- [ ] **Step 3: 実装する**

`src/ui/SetupView.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { openGroupDatabase } from '../db/group-db'
import {
  buildEmailRegistration,
  markEmailConfirmed,
  sendEmailRegistration,
} from '../group/email-registration'
import type { Session } from '../group/session'
import type { InboxGrant } from '../inbox/grants'
import { readGrant } from '../inbox/grants'
import type { StorageProvider } from '../storage/provider'
import { flushOutbox } from '../sync/outbox'

const props = defineProps<{ session: Session; storage: StorageProvider }>()
const emit = defineEmits<{ done: [] }>()

const grant = ref<InboxGrant | null>(null)
const email = ref('')
const registered = ref(false)
const error = ref('')
const busy = ref(false)

const db = openGroupDatabase(props.session.groupId)

onMounted(async () => {
  try {
    grant.value = await readGrant({
      storage: props.storage,
      groupId: props.session.groupId,
      userId: props.session.userId,
      ecdhPrivate: props.session.ecdhPrivate,
    })
  } catch {
    grant.value = null
  }
})

async function register(): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    if (!grant.value) {
      throw new Error('いまは登録できません。担当者がアプリを開くまでお待ちください。')
    }
    const registration = buildEmailRegistration({ session: props.session, email: email.value })
    await sendEmailRegistration({
      session: props.session,
      db,
      grant: grant.value,
      registration,
    })
    await flushOutbox({ db, storage: props.storage })
    registered.value = true
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'メールアドレスを登録できませんでした'
  } finally {
    busy.value = false
  }
}

async function confirm(): Promise<void> {
  await markEmailConfirmed(db)
  emit('done')
}
</script>

<template>
  <section>
    <h1>はじめの設定</h1>
    <p>
      メールアドレスを登録してください。お知らせの通知先として必要です。
      登録が済むまで、お知らせの閲覧はロックされています。
    </p>
    <p>登録したアドレスは担当者と管理者だけが見られます。ほかの参加者には表示されません。</p>

    <label>
      メールアドレス
      <input type="email" data-test="email" v-model="email" />
    </label>

    <p v-if="error" data-test="error">{{ error }}</p>

    <button type="button" data-test="register" :disabled="busy" @click="register">
      登録する
    </button>

    <div v-if="registered">
      <p>
        届くかどうかの確認をします。担当者がテスト通知を送ります。
        届いたら下のボタンを押してください。
      </p>
      <button type="button" data-test="confirm" @click="confirm">
        テスト通知が届きました
      </button>
    </div>
  </section>
</template>
```

`src/App.vue` で、参加者かつ未確認ならこの画面を出す。

```ts
const emailConfirmed = ref(true)

async function onLogin(next: Session, root: string): Promise<void> {
  session.value = next
  storage.value = new HttpStorageProvider(root)
  emailConfirmed.value =
    next.role !== 'member' || (await isEmailConfirmed(openGroupDatabase(next.groupId)))
}
```

テンプレートでは `LoginView` の次に置く。

```vue
    <SetupView
      v-else-if="!emailConfirmed"
      :session="session"
      :storage="storage"
      @done="emailConfirmed = true"
    />
```

- [ ] **Step 4: 全体の検証**

```bash
npm run test:run
npm run typecheck
npm run build
```

Expected: すべて成功。

- [ ] **Step 5: コミット**

```bash
git add src/ui/SetupView.vue src/App.vue tests/ui/SetupView.test.ts
git commit -m "feat(ui): add the first-run setup screen that gates on email registration"
```

---

## Phase 2c 完了条件

- `npm run test:run` が全て green
- `npm run typecheck` がエラーなし
- `npm run build` が成功する
- 「参加者が不在連絡を送る → 担当者が回収して読める」が Task 4 と Task 5 のテストで通っている
- **参加者が staff スコープ鍵を要求するコードが1行も無い**(設計書 §4.6)
- `as never` で型を黙らせている箇所が残っていない

## 次フェーズへの引き継ぎ

- 回収した投函物を events へ転記し、名簿の staff 部(連絡先)へ反映する処理 → Phase 2d
- 定型理由をグループ設定 (`settings/templates.enc`) から読む → Phase 2d
- mailto 通知、開設ウィザード、リカバリキット → Phase 2d
- キーストア更新・push購読の上り(設計書 §8 が挙げている残りの用途)
- フォーム回答 → Phase 3。Task 1 の `sealForRecipients` が宛先1人でそのまま使える
- **`publishGrants` を担当者の画面から呼ぶ導線がまだ無い。** Phase 2d の管理画面で
  「アプリを開いたら配布し直す」を実装するまで、grant は手動で置く必要がある

## 実装前に確認すること

- Task 3 と Task 6 で `SyncState['key']` のユニオンを2回広げる。`as never` を残さないこと
- Task 7 と Task 8 で `App.vue` を続けて変更する。Task 8 の形が最終形
