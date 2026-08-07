# Phase 2b: メッセージの投稿と閲覧 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 担当者が複数スコープ宛にメッセージと添付を投稿でき、参加者が自分の所属スコープのぶんだけタイムラインで読める状態にする。

**Architecture:** 投稿は「添付 → メッセージ本体 → イベント」の順にそれぞれ独立した暗号化オブジェクトとしてストレージへ置く。イベントは軽く保ち、本文と添付は参照先に逃がすことで、同期時のイベント走査を小さく保つ。すべて outbox 経由で送るのでオフラインでもそのまま投稿でき、復帰時に送信される。受信側は同期したイベントを投影してローカルDBの `messages` / `files` を更新する。

**Tech Stack:** Vue 3 / TypeScript / Vite / Vitest / Dexie.js / Web Crypto API

正は [要件書](../../Mofune%20-%20要件書.md) / [設計書](../../Mofune%20-%20設計書.md)。Phase 1 と Phase 2a の成果物の上に載る。

## Global Constraints

Phase 1 / 2a の Global Constraints をすべて引き継ぐ。特に:

- 暗号プリミティブは Web Crypto API のみ。例外は Argon2id (hash-wasm) のみ
- **バイト列の型は `src/crypto/bytes.ts` の `Bytes`(= `Uint8Array<ArrayBuffer>`)を使う。** 型注釈上の `Uint8Array` はすべて `Bytes` と読み替える(`new Uint8Array(...)` という生成式はそのまま)。テストの `as Uint8Array` も `as Bytes` に読み替える
- 秘密鍵・パスワード・ストレージ資格情報を IndexedDB / localStorage に保存してはならない。セッションはメモリ上のみ
- ロールは `admin` / `staff` / `member`。UI 表示は管理者 / 担当者 / 参加者。用途固有語(園・クラス・先生・保護者)をコードにもUIにも持ち込まない
- スコープ鍵はすべて独立に生成する。サブグループの親子関係から子の鍵を導出してはならない
- **暗号化オブジェクトは必ずマルチレシピエントエンベロープ(`sealEnvelopeFor`)を通す。** スコープ鍵で本文を直接暗号化しない
- ストレージパスを組み立てる箇所は `assertSafePath` を通す(Phase 2a のセキュリティ修正)
- **既読情報を送出してはならない。** 未読は端末ローカル計算のみ(要件書 §4.10)
- `tsconfig.json` は `strict: true` と `verbatimModuleSyntax: true`。型のみの import は `import type`
- テストは `tests/**/*.test.ts`。Vitest のグローバル API は使わず `import { describe, it, expect } from 'vitest'` を明示する
- DOM が要るテストはファイル先頭に `// @vitest-environment happy-dom` を書く
- 本番の KDF パラメータ (`PRODUCTION_KDF`) をテストで使わない。テストは必ず `TEST_KDF`
- コミットは Conventional Commits 形式。`Co-Authored-By` 行は付けない
- バージョン番号を手で書かない。新規依存は `npm install` で解決させる
- 実行時に外部CDNへ接続しない(要件書 §5.2)

## 既存インターフェース(実装前に確認済み)

このプランが依存する Phase 1 / 2a の定義。名前と形はここに書いたとおりで確定している。

```ts
// src/crypto/envelope.ts
interface SealTarget { keyId: string; key: CryptoKey }
sealEnvelopeFor(targets: SealTarget[], plaintext: Bytes): Promise<Bytes>
openEnvelope(keys: ReadonlyMap<string, CryptoKey>, bytes: Bytes): Promise<Bytes>
readKeyIds(bytes: Bytes): string[]
class DecryptionError extends Error {}

// src/crypto/keyring.ts
keyId(scope: string, generation: number): string    // `${scope}:v${generation}`

// src/crypto/roster.ts
const ALL_SCOPE = 'all'; const STAFF_SCOPE = 'staff'
type Role = 'admin' | 'staff' | 'member'

// src/group/session.ts
interface Session {
  groupId: string; groupName: string; userId: string; displayName: string
  role: Role; scopes: string[]; groupKeys: Map<string, CryptoKey>
  roster: RosterContents; ecdhPrivate: Bytes; ecdsaPrivate: Bytes
}

// src/storage/paths.ts
messagePath(groupId: string, messageId: string): string   // `${groupId}/messages/${messageId}.enc`
filePath(groupId: string, fileId: string): string         // `${groupId}/files/${fileId}.enc`
eventPath(groupId: string, eventId: string): string

// src/sync/events.ts
type EventType = 'MESSAGE_CREATED' | 'FILE_ADDED' | 'MEMBER_UPDATED'
interface GroupEvent { id: string; type: EventType; author: string; at: string; payload: Record<string, unknown> }
newEventId(now?: Date): string
eventPathFor(groupId: string, id: string): string
sealEvent(event: GroupEvent, targets: SealTarget[]): Promise<Bytes>
openEvent(keys: ReadonlyMap<string, CryptoKey>, bytes: Bytes): Promise<GroupEvent>

// src/sync/sync.ts
interface SyncResult { applied: number; skipped: number; cursor: string | null }
syncGroup(options: { storage; groupId; keys; db }): Promise<SyncResult>

// src/sync/outbox.ts
enqueue(db: GroupDatabase, item: Omit<OutboxItem, 'queuedAt' | 'attempts'>): Promise<void>
flushOutbox(options: { db: GroupDatabase; storage: StorageProvider }): Promise<FlushResult>

// src/db/group-db.ts
interface CachedMessage { id: string; scopes: string[]; author: string; at: string; body: string; attachments: string[] }
interface CachedFile { id: string; mediaType: string; size: number; blob: Bytes; cachedAt: string }
interface OutboxItem { id: string; kind: 'event' | 'inbox'; path: string; body: Bytes; queuedAt: string; attempts: number }
openGroupDatabase(groupId: string): GroupDatabase
```

## File Structure

```
src/content/attachments.ts    添付の封緘・復元と ID 採番                    Task 1
src/content/messages.ts       メッセージ本体の封緘・復元                    Task 2
src/content/post.ts           宛先解決と投稿(添付→本体→イベント)         Task 3
src/db/group-db.ts            OutboxItem.kind に object を追加(既存を変更)  Task 3
src/sync/projection.ts        イベント → messages/files への投影            Task 4
src/sync/sync.ts              投影の組み込み(既存を変更)                  Task 4
src/db/group-db.ts            CachedMessage に未読判定用の項目を追加        Task 4
src/ui/TimelineView.vue       タイムライン (design 03)                      Task 5
src/ui/MessageDetailView.vue  メッセージ詳細 (design 04)                    Task 6
src/ui/ComposeView.vue        投稿作成 (design 06)                          Task 7
src/App.vue                   画面遷移の配線(既存を変更)                  Task 5-7
```

Task 1-4 がドメイン層、Task 5-7 が画面。Task 4 の時点で「投稿 → 同期 → ローカルDBに現れる」がテストで通り、Task 7 で画面から一周する。

---

### Task 1: 添付ファイルの封緘と復元

**Files:**
- Create: `src/content/attachments.ts`
- Test: `tests/content/attachments.test.ts`

**Interfaces:**
- Consumes: `Bytes` / `fromUtf8` / `toBase64` / `fromBase64` / `toHex` / `utf8`、`randomBytes` / `sha256`、`SealTarget` / `sealEnvelopeFor` / `openEnvelope`
- Produces: `class AttachmentFormatError extends Error`、`interface AttachmentRef { fileId: string; name: string; mediaType: string; size: number; contentHash: string }`、`interface OpenedAttachment { name: string; mediaType: string; bytes: Bytes }`、`newFileId(): string` / `sealAttachment(input: { name: string; mediaType: string; bytes: Bytes }, targets: SealTarget[]): Promise<{ ref: AttachmentRef; sealed: Bytes }>` / `openAttachment(keys: ReadonlyMap<string, CryptoKey>, bytes: Bytes): Promise<OpenedAttachment>`

添付は写真だけでなく PDF 等も扱う(要件書 §4.1、design 03 の「8月予定表.pdf」)。ファイル名と MIME タイプも中身と同じく秘匿対象なので、**暗号化の内側**に入れる。平文で外に出るのはオブジェクトのサイズと更新時刻だけ。

`contentHash` は平文の SHA-256 で、これも暗号化の内側に置く(設計書 §4.5)。外に出すと「この写真を持っているか」を鍵なしで確認されてしまう。今フェーズでは重複排除そのものは実装せず、後で入れられるようにハッシュを記録するところまで行う。

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/attachments.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  AttachmentFormatError,
  newFileId,
  openAttachment,
  sealAttachment,
} from '../../src/content/attachments'
import { generateAesKey, sha256 } from '../../src/crypto/symmetric'
import { readKeyIds, sealEnvelopeFor } from '../../src/crypto/envelope'
import { fromUtf8, toHex, utf8 } from '../../src/crypto/bytes'

const photo = { name: '運動会.jpg', mediaType: 'image/jpeg', bytes: utf8('binary-ish') }

describe('newFileId', () => {
  it('is a random hex id', () => {
    expect(newFileId()).toMatch(/^f_[0-9a-f]{32}$/)
  })

  it('does not repeat', () => {
    expect(newFileId()).not.toBe(newFileId())
  })
})

describe('sealAttachment / openAttachment', () => {
  it('round-trips the bytes, name and media type', async () => {
    const key = await generateAesKey()
    const { ref, sealed } = await sealAttachment(photo, [{ keyId: 'sg_a:v1', key }])
    const opened = await openAttachment(new Map([['sg_a:v1', key]]), sealed)
    expect(opened.name).toBe('運動会.jpg')
    expect(opened.mediaType).toBe('image/jpeg')
    expect(fromUtf8(opened.bytes)).toBe('binary-ish')
    expect(ref.size).toBe(photo.bytes.length)
  })

  it('records the plaintext hash in the reference', async () => {
    const key = await generateAesKey()
    const { ref } = await sealAttachment(photo, [{ keyId: 'sg_a:v1', key }])
    expect(ref.contentHash).toBe(toHex(await sha256(photo.bytes)))
  })

  it('addresses the attachment to every scope it was posted to', async () => {
    const team = await generateAesKey()
    const pickup = await generateAesKey()
    const { sealed } = await sealAttachment(photo, [
      { keyId: 'sg_a:v1', key: team },
      { keyId: 'sg_a_pickup:v1', key: pickup },
    ])
    expect(readKeyIds(sealed)).toEqual(['sg_a:v1', 'sg_a_pickup:v1'])
    expect((await openAttachment(new Map([['sg_a_pickup:v1', pickup]]), sealed)).name).toBe(
      '運動会.jpg',
    )
  })

  it('does not leak the file name, media type or content hash into the ciphertext', async () => {
    const key = await generateAesKey()
    const { ref, sealed } = await sealAttachment(photo, [{ keyId: 'sg_a:v1', key }])
    const raw = new TextDecoder().decode(sealed)
    expect(raw).not.toContain('運動会')
    expect(raw).not.toContain('image/jpeg')
    expect(raw).not.toContain(ref.contentHash)
    expect(raw).not.toContain('binary-ish')
  })

  it('gives every attachment a distinct file id', async () => {
    const key = await generateAesKey()
    const a = await sealAttachment(photo, [{ keyId: 'sg_a:v1', key }])
    const b = await sealAttachment(photo, [{ keyId: 'sg_a:v1', key }])
    expect(a.ref.fileId).not.toBe(b.ref.fileId)
  })

  it('cannot be opened without a matching key', async () => {
    const key = await generateAesKey()
    const { sealed } = await sealAttachment(photo, [{ keyId: 'sg_a:v1', key }])
    const stranger = new Map([['sg_b:v1', await generateAesKey()]])
    await expect(openAttachment(stranger, sealed)).rejects.toThrow()
  })

  it('rejects a payload that is not an attachment', async () => {
    const key = await generateAesKey()
    const bogus = await sealEnvelopeFor([{ keyId: 'sg_a:v1', key }], utf8('{"nope":true}'))
    await expect(openAttachment(new Map([['sg_a:v1', key]]), bogus)).rejects.toThrow(
      AttachmentFormatError,
    )
  })

  it('handles an empty file', async () => {
    const key = await generateAesKey()
    const empty = { name: 'empty.txt', mediaType: 'text/plain', bytes: new Uint8Array(0) }
    const { ref, sealed } = await sealAttachment(empty, [{ keyId: 'sg_a:v1', key }])
    expect(ref.size).toBe(0)
    expect((await openAttachment(new Map([['sg_a:v1', key]]), sealed)).bytes).toHaveLength(0)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/content/attachments.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/content/attachments"`

- [ ] **Step 3: 実装する**

`src/content/attachments.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import { fromBase64, fromUtf8, toBase64, toHex, utf8 } from '../crypto/bytes'
import type { SealTarget } from '../crypto/envelope'
import { openEnvelope, sealEnvelopeFor } from '../crypto/envelope'
import { randomBytes, sha256 } from '../crypto/symmetric'

export class AttachmentFormatError extends Error {}

/** メッセージから添付を指すための参照。メッセージ本体の中(暗号化の内側)に入る。 */
export interface AttachmentRef {
  fileId: string
  name: string
  mediaType: string
  size: number
  /** 平文の SHA-256 (hex)。将来の重複排除用。外には出さない。 */
  contentHash: string
}

export interface OpenedAttachment {
  name: string
  mediaType: string
  bytes: Bytes
}

interface AttachmentPayload {
  name: string
  mediaType: string
  contentHash: string
  /** base64。JSON に載せるためやむを得ず膨らむが、暗号化の内側なので秘匿性は保たれる。 */
  data: string
}

export function newFileId(): string {
  return `f_${toHex(randomBytes(16))}`
}

/**
 * 添付を封緘する。ファイル名・MIME タイプ・平文ハッシュも暗号化の内側に入れる。
 * 平文で外に出るのはオブジェクトのサイズと更新時刻だけ(要件書 §5.3)。
 */
export async function sealAttachment(
  input: { name: string; mediaType: string; bytes: Bytes },
  targets: SealTarget[],
): Promise<{ ref: AttachmentRef; sealed: Bytes }> {
  const contentHash = toHex(await sha256(input.bytes))
  const payload: AttachmentPayload = {
    name: input.name,
    mediaType: input.mediaType,
    contentHash,
    data: toBase64(input.bytes),
  }
  const sealed = await sealEnvelopeFor(targets, utf8(JSON.stringify(payload)))
  return {
    ref: {
      fileId: newFileId(),
      name: input.name,
      mediaType: input.mediaType,
      size: input.bytes.length,
      contentHash,
    },
    sealed,
  }
}

export async function openAttachment(
  keys: ReadonlyMap<string, CryptoKey>,
  bytes: Bytes,
): Promise<OpenedAttachment> {
  const plaintext = await openEnvelope(keys, bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(plaintext))
  } catch {
    throw new AttachmentFormatError('attachment body is not valid JSON')
  }
  const payload = parsed as AttachmentPayload
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.name !== 'string' ||
    typeof payload.mediaType !== 'string' ||
    typeof payload.data !== 'string'
  ) {
    throw new AttachmentFormatError('attachment is missing required fields')
  }
  return {
    name: payload.name,
    mediaType: payload.mediaType,
    bytes: fromBase64(payload.data),
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/content/attachments.test.ts
npm run typecheck
```

Expected: 10 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/content/attachments.ts tests/content/attachments.test.ts
git commit -m "feat(content): seal attachments with their name and media type inside the ciphertext"
```

---

### Task 2: メッセージ本体の封緘と復元

**Files:**
- Create: `src/content/messages.ts`
- Test: `tests/content/messages.test.ts`

**Interfaces:**
- Consumes: Task 1 の `AttachmentRef`、`Bytes` / `fromUtf8` / `toHex` / `utf8`、`randomBytes`、`SealTarget` / `sealEnvelopeFor` / `openEnvelope`
- Produces: `class MessageFormatError extends Error`、`interface MessageContent { id: string; scopes: string[]; author: string; at: string; body: string; attachments: AttachmentRef[] }`、`newMessageId(): string` / `sealMessage(message: MessageContent, targets: SealTarget[]): Promise<Bytes>` / `openMessage(keys: ReadonlyMap<string, CryptoKey>, bytes: Bytes): Promise<MessageContent>`

メッセージ本体を独立したオブジェクトにするのは、イベントログを軽く保つため。同期はイベントを全件走査するので、本文や添付参照をイベントに埋めると走査が重くなる。イベントは `{ messageId }` だけを運ぶ(Task 3)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/messages.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  MessageFormatError,
  newMessageId,
  openMessage,
  sealMessage,
} from '../../src/content/messages'
import type { MessageContent } from '../../src/content/messages'
import { generateAesKey } from '../../src/crypto/symmetric'
import { readKeyIds, sealEnvelopeFor } from '../../src/crypto/envelope'
import { utf8 } from '../../src/crypto/bytes'

const message: MessageContent = {
  id: 'm_0123456789abcdef0123456789abcdef',
  scopes: ['sg_a', 'sg_a_pickup'],
  author: 'u_tanaka',
  at: '2026-08-07T09:12:34.000Z',
  body: '8月14日(金)10時に集合です。持ち物は飲み物とタオル、名札です。',
  attachments: [
    {
      fileId: 'f_00112233445566778899aabbccddeeff',
      name: '案内図.png',
      mediaType: 'image/png',
      size: 1024,
      contentHash: 'a'.repeat(64),
    },
  ],
}

describe('newMessageId', () => {
  it('is a random hex id', () => {
    expect(newMessageId()).toMatch(/^m_[0-9a-f]{32}$/)
  })

  it('does not repeat', () => {
    expect(newMessageId()).not.toBe(newMessageId())
  })
})

describe('sealMessage / openMessage', () => {
  it('round-trips the whole message', async () => {
    const key = await generateAesKey()
    const sealed = await sealMessage(message, [{ keyId: 'sg_a:v1', key }])
    expect(await openMessage(new Map([['sg_a:v1', key]]), sealed)).toEqual(message)
  })

  it('addresses the message to every scope it was posted to', async () => {
    const team = await generateAesKey()
    const pickup = await generateAesKey()
    const sealed = await sealMessage(message, [
      { keyId: 'sg_a:v1', key: team },
      { keyId: 'sg_a_pickup:v1', key: pickup },
    ])
    expect(readKeyIds(sealed)).toEqual(['sg_a:v1', 'sg_a_pickup:v1'])
    expect((await openMessage(new Map([['sg_a_pickup:v1', pickup]]), sealed)).body).toBe(
      message.body,
    )
  })

  it('does not leak the body, author or attachment name into the ciphertext', async () => {
    const key = await generateAesKey()
    const sealed = await sealMessage(message, [{ keyId: 'sg_a:v1', key }])
    const raw = new TextDecoder().decode(sealed)
    expect(raw).not.toContain('集合')
    expect(raw).not.toContain('u_tanaka')
    expect(raw).not.toContain('案内図')
  })

  it('round-trips a message with no attachments', async () => {
    const key = await generateAesKey()
    const plain: MessageContent = { ...message, attachments: [] }
    const sealed = await sealMessage(plain, [{ keyId: 'sg_a:v1', key }])
    expect((await openMessage(new Map([['sg_a:v1', key]]), sealed)).attachments).toEqual([])
  })

  it('cannot be opened by someone outside every addressed scope', async () => {
    const key = await generateAesKey()
    const sealed = await sealMessage(message, [{ keyId: 'sg_a:v1', key }])
    const stranger = new Map([['sg_b:v1', await generateAesKey()]])
    await expect(openMessage(stranger, sealed)).rejects.toThrow()
  })

  it('rejects a payload that is not a message', async () => {
    const key = await generateAesKey()
    const bogus = await sealEnvelopeFor([{ keyId: 'sg_a:v1', key }], utf8('{"nope":true}'))
    await expect(openMessage(new Map([['sg_a:v1', key]]), bogus)).rejects.toThrow(
      MessageFormatError,
    )
  })

  it('rejects a message whose attachments field is not an array', async () => {
    const key = await generateAesKey()
    const broken = await sealEnvelopeFor(
      [{ keyId: 'sg_a:v1', key }],
      utf8(JSON.stringify({ ...message, attachments: 'nope' })),
    )
    await expect(openMessage(new Map([['sg_a:v1', key]]), broken)).rejects.toThrow(
      MessageFormatError,
    )
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/content/messages.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/content/messages"`

- [ ] **Step 3: 実装する**

`src/content/messages.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import { fromUtf8, toHex, utf8 } from '../crypto/bytes'
import type { SealTarget } from '../crypto/envelope'
import { openEnvelope, sealEnvelopeFor } from '../crypto/envelope'
import { randomBytes } from '../crypto/symmetric'
import type { AttachmentRef } from './attachments'

export class MessageFormatError extends Error {}

export interface MessageContent {
  id: string
  /** 配信先スコープ。世代を含まない素のスコープ id。 */
  scopes: string[]
  author: string
  at: string
  body: string
  attachments: AttachmentRef[]
}

export function newMessageId(): string {
  return `m_${toHex(randomBytes(16))}`
}

export async function sealMessage(
  message: MessageContent,
  targets: SealTarget[],
): Promise<Bytes> {
  return sealEnvelopeFor(targets, utf8(JSON.stringify(message)))
}

export async function openMessage(
  keys: ReadonlyMap<string, CryptoKey>,
  bytes: Bytes,
): Promise<MessageContent> {
  const plaintext = await openEnvelope(keys, bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(plaintext))
  } catch {
    throw new MessageFormatError('message body is not valid JSON')
  }
  const message = parsed as MessageContent
  if (
    message === null ||
    typeof message !== 'object' ||
    typeof message.id !== 'string' ||
    typeof message.author !== 'string' ||
    typeof message.body !== 'string'
  ) {
    throw new MessageFormatError('message is missing required fields')
  }
  if (!Array.isArray(message.attachments) || !Array.isArray(message.scopes)) {
    throw new MessageFormatError('message scopes and attachments must be arrays')
  }
  return message
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/content/messages.test.ts
npm run typecheck
```

Expected: 9 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/content/messages.ts tests/content/messages.test.ts
git commit -m "feat(content): seal message bodies as standalone objects"
```

---
### Task 3: 宛先の解決と投稿

**Files:**
- Create: `src/content/post.ts`
- Modify: `src/db/group-db.ts`(`OutboxItem.kind` に `object` を追加)
- Test: `tests/content/post.test.ts`

**Interfaces:**
- Consumes: Task 1 の `AttachmentRef` / `sealAttachment`、Task 2 の `MessageContent` / `newMessageId` / `sealMessage`、`Session`、`SealTarget`、`newEventId` / `eventPathFor` / `sealEvent` / `GroupEvent`、`messagePath` / `filePath`、`enqueue` / `GroupDatabase`
- Produces: `class PostError extends Error`、`interface DraftAttachment { name: string; mediaType: string; bytes: Bytes }`、`interface Draft { body: string; scopes: string[]; attachments: DraftAttachment[] }`、`interface PostResult { messageId: string; eventId: string; attachments: AttachmentRef[] }`、`resolveTargets(session: Session, scopes: string[]): SealTarget[]` / `createPost(options: { session: Session; db: GroupDatabase; draft: Draft; now?: Date }): Promise<PostResult>`

まず `src/db/group-db.ts` の `OutboxItem` を1行変更する。ファイル本体・メッセージ本体はイベントではないので、種別を分ける。

```ts
export interface OutboxItem {
  id: string
  /** object: files/ と messages/ の実体。event: events/ の追記。inbox: 上りの投函。 */
  kind: 'object' | 'event' | 'inbox'
  path: string
  body: Bytes
  queuedAt: string
  attempts: number
}
```

既存の `tests/sync/outbox.test.ts` は `kind: 'event'` を使っており、そのまま通る。

投稿の中核。design 06 の「届ける相手」で選ばれた複数スコープに対し、添付・本体・イベントの3種を**同じ宛先集合**で封緘する。1つでも宛先がずれると、片方だけ読めて片方読めないという最悪の壊れ方をするので、宛先は `resolveTargets` で1回だけ解決して使い回す。

`resolveTargets` はスコープ名(`sg_a`)を、セッションが実際に保持している鍵の `keyId`(`sg_a:v1`)へ解決する。世代を投稿側が勝手に決めないのが要点で、自分が持っている鍵の世代をそのまま使う。持っていないスコープを指定されたら投稿を止める(黙って宛先から落とすと、届いていないのに届いたつもりになる)。

**すべて outbox 経由で送る。** オフラインでも投稿でき、復帰時に `flushOutbox` が送る(要件書 §4.9)。送信順は queuedAt 順なので、添付 → 本体 → イベントの順に積めば、受信側がイベントを見た時点で参照先が揃っている。

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/post.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PostError, createPost, resolveTargets } from '../../src/content/post'
import type { Draft } from '../../src/content/post'
import { openMessage } from '../../src/content/messages'
import { openAttachment } from '../../src/content/attachments'
import { openEvent } from '../../src/sync/events'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { flushOutbox, pending } from '../../src/sync/outbox'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { RosterContents } from '../../src/crypto/roster'

const roster: RosterContents = { groupId: 'midori', generation: 1, subgroups: [], members: [] }

async function staffSession(): Promise<Session> {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role: 'staff',
    scopes: ['all', 'staff', 'sg_a', 'sg_a_pickup'],
    groupKeys: new Map([
      ['all:v1', await generateAesKey()],
      ['staff:v1', await generateAesKey()],
      ['sg_a:v1', await generateAesKey()],
      ['sg_a_pickup:v1', await generateAesKey()],
    ]),
    roster,
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
}

const draft: Draft = {
  body: '来週の集まりについて',
  scopes: ['sg_a', 'sg_a_pickup'],
  attachments: [{ name: '案内図.png', mediaType: 'image/png', bytes: utf8('png-bytes') }],
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('resolveTargets', () => {
  it('resolves scope names to the key ids the session actually holds', async () => {
    const session = await staffSession()
    expect(resolveTargets(session, ['sg_a', 'sg_a_pickup']).map((t) => t.keyId)).toEqual([
      'sg_a:v1',
      'sg_a_pickup:v1',
    ])
  })

  it('refuses a scope the session has no key for', async () => {
    const session = await staffSession()
    expect(() => resolveTargets(session, ['sg_b'])).toThrow(PostError)
  })

  it('refuses an empty scope list', async () => {
    const session = await staffSession()
    expect(() => resolveTargets(session, [])).toThrow(PostError)
  })

  it('deduplicates repeated scopes', async () => {
    const session = await staffSession()
    expect(resolveTargets(session, ['sg_a', 'sg_a']).map((t) => t.keyId)).toEqual(['sg_a:v1'])
  })
})

describe('createPost', () => {
  it('queues the attachment, the message and the event in that order', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const result = await createPost({ session, db, draft })
    const queued = await pending(db)
    expect(queued).toHaveLength(3)
    expect(queued[0]?.path).toBe(`midori/files/${result.attachments[0]?.fileId}.enc`)
    expect(queued[1]?.path).toBe(`midori/messages/${result.messageId}.enc`)
    expect(queued[2]?.path).toBe(`midori/events/${result.eventId}.enc`)
  })

  it('writes nothing to storage until the outbox is flushed', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    await createPost({ session, db, draft })
    expect(await storage.list('midori/')).toHaveLength(0)
    await flushOutbox({ db, storage })
    expect(await storage.list('midori/')).toHaveLength(3)
  })

  it('produces a message readable by a member of either addressed scope', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    const result = await createPost({ session, db, draft })
    await flushOutbox({ db, storage })

    const teamOnly = new Map([['sg_a:v1', session.groupKeys.get('sg_a:v1') as CryptoKey]])
    const message = await openMessage(
      teamOnly,
      await storage.get(`midori/messages/${result.messageId}.enc`),
    )
    expect(message.body).toBe('来週の集まりについて')
    expect(message.author).toBe('u_tanaka')
    expect(message.scopes).toEqual(['sg_a', 'sg_a_pickup'])
  })

  it('produces an attachment readable with the same keys', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    const result = await createPost({ session, db, draft })
    await flushOutbox({ db, storage })

    const keys = new Map([['sg_a:v1', session.groupKeys.get('sg_a:v1') as CryptoKey]])
    const opened = await openAttachment(
      keys,
      await storage.get(`midori/files/${result.attachments[0]?.fileId}.enc`),
    )
    expect(opened.name).toBe('案内図.png')
  })

  it('emits a MESSAGE_CREATED event that points at the message', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    const result = await createPost({ session, db, draft })
    await flushOutbox({ db, storage })

    const keys = new Map([['sg_a:v1', session.groupKeys.get('sg_a:v1') as CryptoKey]])
    const event = await openEvent(keys, await storage.get(`midori/events/${result.eventId}.enc`))
    expect(event.type).toBe('MESSAGE_CREATED')
    expect(event.author).toBe('u_tanaka')
    expect(event.payload['messageId']).toBe(result.messageId)
  })

  it('keeps the event small by not embedding the body', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    const result = await createPost({ session, db, draft })
    await flushOutbox({ db, storage })
    const event = await storage.get(`midori/events/${result.eventId}.enc`)
    const message = await storage.get(`midori/messages/${result.messageId}.enc`)
    expect(event.length).toBeLessThan(message.length)
  })

  it('is not readable by a scope that was not addressed', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    const result = await createPost({ session, db, draft })
    await flushOutbox({ db, storage })

    const outsider = new Map([['all:v1', session.groupKeys.get('all:v1') as CryptoKey]])
    await expect(
      openMessage(outsider, await storage.get(`midori/messages/${result.messageId}.enc`)),
    ).rejects.toThrow()
  })

  it('posts without attachments', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const result = await createPost({
      session,
      db,
      draft: { ...draft, attachments: [] },
    })
    expect(result.attachments).toEqual([])
    expect(await pending(db)).toHaveLength(2)
  })

  it('refuses to post as a member', async () => {
    const session = { ...(await staffSession()), role: 'member' as const }
    const db = openGroupDatabase('midori')
    await expect(createPost({ session, db, draft })).rejects.toThrow(PostError)
  })

  it('refuses an empty body with no attachments', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    await expect(
      createPost({ session, db, draft: { body: '   ', scopes: ['sg_a'], attachments: [] } }),
    ).rejects.toThrow(PostError)
  })

  it('stamps the message and the event with the same time', async () => {
    const session = await staffSession()
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    const now = new Date('2026-08-07T09:12:34.000Z')
    const result = await createPost({ session, db, draft, now })
    await flushOutbox({ db, storage })
    const keys = new Map([['sg_a:v1', session.groupKeys.get('sg_a:v1') as CryptoKey]])
    const message = await openMessage(
      keys,
      await storage.get(`midori/messages/${result.messageId}.enc`),
    )
    const event = await openEvent(keys, await storage.get(`midori/events/${result.eventId}.enc`))
    expect(message.at).toBe('2026-08-07T09:12:34.000Z')
    expect(event.at).toBe('2026-08-07T09:12:34.000Z')
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/content/post.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/content/post"`

- [ ] **Step 3: 実装する**

`src/content/post.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import type { SealTarget } from '../crypto/envelope'
import type { GroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import { filePath, messagePath } from '../storage/paths'
import type { GroupEvent } from '../sync/events'
import { eventPathFor, newEventId, sealEvent } from '../sync/events'
import { enqueue } from '../sync/outbox'
import type { AttachmentRef } from './attachments'
import { sealAttachment } from './attachments'
import type { MessageContent } from './messages'
import { newMessageId, sealMessage } from './messages'

export class PostError extends Error {}

export interface DraftAttachment {
  name: string
  mediaType: string
  bytes: Bytes
}

export interface Draft {
  body: string
  /** 素のスコープ id。世代は resolveTargets が付ける。 */
  scopes: string[]
  attachments: DraftAttachment[]
}

export interface PostResult {
  messageId: string
  eventId: string
  attachments: AttachmentRef[]
}

/**
 * スコープ名を、セッションが実際に保持している鍵の keyId へ解決する。
 * 世代を投稿側で決め打ちせず、手元の鍵の世代をそのまま使う。
 * 鍵を持たないスコープが混ざっていたら投稿を中止する。黙って落とすと
 * 「送ったのに届いていない」ことに投稿者が気づけない。
 */
export function resolveTargets(session: Session, scopes: string[]): SealTarget[] {
  const unique = [...new Set(scopes)]
  if (unique.length === 0) {
    throw new PostError('a post needs at least one target scope')
  }
  return unique.map((scope) => {
    const entry = [...session.groupKeys.entries()].find(
      ([id]) => id.slice(0, id.lastIndexOf(':v')) === scope,
    )
    if (!entry) {
      throw new PostError(`no key held for scope "${scope}"`)
    }
    return { keyId: entry[0], key: entry[1] }
  })
}

/**
 * 添付・本体・イベントを同じ宛先集合で封緘し、outbox へ積む。
 * 添付 → 本体 → イベントの順に積むことで、受信側がイベントを見た時点で
 * 参照先が揃っている(outbox は queuedAt 順に送る)。
 */
export async function createPost(options: {
  session: Session
  db: GroupDatabase
  draft: Draft
  now?: Date
}): Promise<PostResult> {
  const { session, db, draft } = options
  if (session.role === 'member') {
    throw new PostError('members cannot post')
  }
  if (draft.body.trim().length === 0 && draft.attachments.length === 0) {
    throw new PostError('a post needs a body or at least one attachment')
  }

  const targets = resolveTargets(session, draft.scopes)
  const now = options.now ?? new Date()
  const at = now.toISOString()

  const attachments: AttachmentRef[] = []
  for (const attachment of draft.attachments) {
    const { ref, sealed } = await sealAttachment(attachment, targets)
    attachments.push(ref)
    await enqueue(db, {
      id: ref.fileId,
      kind: 'object',
      path: filePath(session.groupId, ref.fileId),
      body: sealed,
    })
  }

  const message: MessageContent = {
    id: newMessageId(),
    scopes: [...new Set(draft.scopes)],
    author: session.userId,
    at,
    body: draft.body,
    attachments,
  }
  await enqueue(db, {
    id: message.id,
    kind: 'object',
    path: messagePath(session.groupId, message.id),
    body: await sealMessage(message, targets),
  })

  const event: GroupEvent = {
    id: newEventId(now),
    type: 'MESSAGE_CREATED',
    author: session.userId,
    at,
    payload: { messageId: message.id },
  }
  await enqueue(db, {
    id: event.id,
    kind: 'event',
    path: eventPathFor(session.groupId, event.id),
    body: await sealEvent(event, targets),
  })

  return { messageId: message.id, eventId: event.id, attachments }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/content/post.test.ts
npm run typecheck
```

Expected: 15 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/content/post.ts src/db/group-db.ts tests/content/post.test.ts
git commit -m "feat(content): compose posts addressed to several scopes at once"
```

---

### Task 4: イベントの投影

**Files:**
- Create: `src/sync/projection.ts`
- Modify: `src/sync/sync.ts`(適用したイベントを投影に渡す)
- Modify: `src/db/group-db.ts`(`CachedMessage` に `read` 判定用の項目は増やさない。理由は下記)
- Test: `tests/sync/projection.test.ts`
- Test: `tests/sync/sync.test.ts`(既存に追記)

**Interfaces:**
- Consumes: Task 1 の `openAttachment`、Task 2 の `openMessage`、`GroupEvent`、`GroupDatabase` / `CachedMessage` / `CachedFile`、`StorageProvider` / `NotFoundError`、`messagePath` / `filePath`
- Produces: `interface ProjectionResult { messages: number; files: number; missing: number }`、`projectEvent(options: { db: GroupDatabase; storage: StorageProvider; groupId: string; keys: ReadonlyMap<string, CryptoKey>; event: GroupEvent }): Promise<ProjectionResult>`

Phase 2a の `syncGroup` はイベントを `events` テーブルに記録するだけだった。ここで `messages` / `files` へ投影する。

**参照先が取れないことは正常系である。** 投稿者の outbox がまだ本体を送り終えていない、あるいは添付だけ送信に失敗している、という状態が普通に起こる。取れなかったものは `missing` として数え、**イベントは記録済みのまま**にする。次回の同期でカーソルより後ろになってしまうと二度と拾えないので、**未解決のイベントは投影待ちとして再試行できる形にする**。今フェーズでは単純に「`messages` に無ければ次回同期時にもう一度取りに行く」方式にする(`pendingProjection` テーブルは作らない。イベントは `events` に残っているので、そこから再投影できる)。

`read` フラグはローカル計算なので DB に持たない(要件書 §4.10)。未読判定は `syncState.lastReadAt` と `CachedMessage.at` の比較で行い、Task 5 の画面で計算する。

- [ ] **Step 1: 失敗するテストを書く**

`tests/sync/projection.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { projectEvent } from '../../src/sync/projection'
import { createPost } from '../../src/content/post'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { flushOutbox } from '../../src/sync/outbox'
import { openEvent } from '../../src/sync/events'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { fromUtf8, utf8 } from '../../src/crypto/bytes'
import type { Session } from '../../src/group/session'
import type { GroupEvent } from '../../src/sync/events'
import type { RosterContents } from '../../src/crypto/roster'

const roster: RosterContents = { groupId: 'midori', generation: 1, subgroups: [], members: [] }

async function staffSession(): Promise<Session> {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_tanaka',
    displayName: '田中 みか',
    role: 'staff',
    scopes: ['sg_a'],
    groupKeys: new Map([['sg_a:v1', await generateAesKey()]]),
    roster,
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
}

/** 投稿を1件作り、ストレージへ送り、そのイベントを返す。 */
async function postedEvent(): Promise<{
  session: Session
  storage: MemoryStorageProvider
  event: GroupEvent
  messageId: string
  fileId: string
}> {
  const session = await staffSession()
  const db = openGroupDatabase('midori')
  const storage = new MemoryStorageProvider()
  const result = await createPost({
    session,
    db,
    draft: {
      body: '来週の集まりについて',
      scopes: ['sg_a'],
      attachments: [{ name: '案内図.png', mediaType: 'image/png', bytes: utf8('png-bytes') }],
    },
  })
  await flushOutbox({ db, storage })
  const event = await openEvent(
    session.groupKeys,
    await storage.get(`midori/events/${result.eventId}.enc`),
  )
  return {
    session,
    storage,
    event,
    messageId: result.messageId,
    fileId: result.attachments[0]?.fileId as string,
  }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('projectEvent', () => {
  it('writes the message into the local cache', async () => {
    const { session, storage, event, messageId } = await postedEvent()
    const db = openGroupDatabase('midori')
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event,
    })
    expect(result.messages).toBe(1)
    const cached = await db.messages.get(messageId)
    expect(cached?.body).toBe('来週の集まりについて')
    expect(cached?.author).toBe('u_tanaka')
    expect(cached?.scopes).toEqual(['sg_a'])
  })

  it('writes the attachment bytes into the local cache', async () => {
    const { session, storage, event, fileId } = await postedEvent()
    const db = openGroupDatabase('midori')
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event,
    })
    expect(result.files).toBe(1)
    const cached = await db.files.get(fileId)
    expect(cached?.mediaType).toBe('image/png')
    expect(fromUtf8(cached?.blob as never)).toBe('png-bytes')
  })

  it('links the message to its attachment ids', async () => {
    const { session, storage, event, messageId, fileId } = await postedEvent()
    const db = openGroupDatabase('midori')
    await projectEvent({ db, storage, groupId: 'midori', keys: session.groupKeys, event })
    expect((await db.messages.get(messageId))?.attachments).toEqual([fileId])
  })

  it('is idempotent when the same event is projected twice', async () => {
    const { session, storage, event } = await postedEvent()
    const db = openGroupDatabase('midori')
    await projectEvent({ db, storage, groupId: 'midori', keys: session.groupKeys, event })
    await projectEvent({ db, storage, groupId: 'midori', keys: session.groupKeys, event })
    expect(await db.messages.count()).toBe(1)
    expect(await db.files.count()).toBe(1)
  })

  it('reports a missing message body instead of throwing', async () => {
    const { session, storage, event, messageId } = await postedEvent()
    await storage.delete(`midori/messages/${messageId}.enc`)
    const db = openGroupDatabase('midori')
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event,
    })
    expect(result.missing).toBe(1)
    expect(await db.messages.count()).toBe(0)
  })

  it('still caches the message when an attachment has not arrived yet', async () => {
    const { session, storage, event, messageId, fileId } = await postedEvent()
    await storage.delete(`midori/files/${fileId}.enc`)
    const db = openGroupDatabase('midori')
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event,
    })
    expect(result.messages).toBe(1)
    expect(result.missing).toBe(1)
    expect(await db.messages.get(messageId)).toBeDefined()
    expect(await db.files.get(fileId)).toBeUndefined()
  })

  it('ignores an event type it does not project', async () => {
    const { session, storage } = await postedEvent()
    const db = openGroupDatabase('midori')
    const other: GroupEvent = {
      id: '20260807T091234Z-aaaa',
      type: 'MEMBER_UPDATED',
      author: 'u_admin',
      at: '2026-08-07T09:12:34.000Z',
      payload: {},
    }
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event: other,
    })
    expect(result).toEqual({ messages: 0, files: 0, missing: 0 })
  })

  it('reports a MESSAGE_CREATED event with no messageId as missing', async () => {
    const { session, storage } = await postedEvent()
    const db = openGroupDatabase('midori')
    const broken: GroupEvent = {
      id: '20260807T091234Z-bbbb',
      type: 'MESSAGE_CREATED',
      author: 'u_tanaka',
      at: '2026-08-07T09:12:34.000Z',
      payload: {},
    }
    const result = await projectEvent({
      db,
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
      event: broken,
    })
    expect(result.missing).toBe(1)
  })
})
```

`tests/sync/sync.test.ts` の `describe('syncGroup')` の中に次を**追記**する。

```ts
  it('projects the messages it applies into the local cache', async () => {
    const { createPost } = await import('../../src/content/post')
    const { openGroupDatabase } = await import('../../src/db/group-db')
    const { flushOutbox } = await import('../../src/sync/outbox')
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    const session = {
      groupId: 'midori',
      groupName: 'みどり台グループ',
      userId: 'u_tanaka',
      displayName: '田中 みか',
      role: 'staff' as const,
      scopes: ['sg_a'],
      groupKeys: new Map([['sg_a:v1', key]]),
      roster: { groupId: 'midori', generation: 1, subgroups: [], members: [] },
      ecdhPrivate: new Uint8Array(0),
      ecdsaPrivate: new Uint8Array(0),
    }
    const authorDb = openGroupDatabase('midori')
    const result = await createPost({
      session,
      db: authorDb,
      draft: { body: 'こんにちは', scopes: ['sg_a'], attachments: [] },
    })
    await flushOutbox({ db: authorDb, storage })
    await deleteGroupDatabase('midori')

    const readerDb = openGroupDatabase('midori')
    const synced = await syncGroup({
      storage,
      groupId: 'midori',
      keys: new Map([['sg_a:v1', key]]),
      db: readerDb,
    })
    expect(synced.applied).toBe(1)
    expect((await readerDb.messages.get(result.messageId))?.body).toBe('こんにちは')
  })
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/sync/projection.test.ts tests/sync/sync.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/sync/projection"` と、sync 側の追記テストが `readerDb.messages` に何も無くて失敗する。

- [ ] **Step 3: 実装する**

`src/sync/projection.ts`:

```ts
import { openAttachment } from '../content/attachments'
import { openMessage } from '../content/messages'
import type { CachedFile, CachedMessage, GroupDatabase } from '../db/group-db'
import type { StorageProvider } from '../storage/provider'
import { filePath, messagePath } from '../storage/paths'
import type { GroupEvent } from './events'

export interface ProjectionResult {
  messages: number
  files: number
  /** 参照先がまだ届いていない等で解決できなかった数。異常ではない。 */
  missing: number
}

/**
 * イベントを messages / files テーブルへ投影する。
 *
 * 参照先が取得できないのは正常系(投稿者の outbox がまだ送り終えていない、
 * 添付だけ失敗している等)。例外にせず missing として数え、イベント自体は
 * events テーブルに残るので次回以降に再投影できる。
 */
export async function projectEvent(options: {
  db: GroupDatabase
  storage: StorageProvider
  groupId: string
  keys: ReadonlyMap<string, CryptoKey>
  event: GroupEvent
}): Promise<ProjectionResult> {
  const result: ProjectionResult = { messages: 0, files: 0, missing: 0 }
  if (options.event.type !== 'MESSAGE_CREATED') {
    return result
  }

  const messageId = options.event.payload['messageId']
  if (typeof messageId !== 'string') {
    result.missing += 1
    return result
  }

  let message
  try {
    message = await openMessage(
      options.keys,
      await options.storage.get(messagePath(options.groupId, messageId)),
    )
  } catch {
    result.missing += 1
    return result
  }

  const cached: CachedMessage = {
    id: message.id,
    scopes: message.scopes,
    author: message.author,
    at: message.at,
    body: message.body,
    attachments: message.attachments.map((attachment) => attachment.fileId),
  }
  await options.db.messages.put(cached)
  result.messages += 1

  for (const ref of message.attachments) {
    if (await options.db.files.get(ref.fileId)) continue
    try {
      const opened = await openAttachment(
        options.keys,
        await options.storage.get(filePath(options.groupId, ref.fileId)),
      )
      const file: CachedFile = {
        id: ref.fileId,
        mediaType: opened.mediaType,
        size: opened.bytes.length,
        blob: opened.bytes,
        cachedAt: new Date().toISOString(),
      }
      await options.db.files.put(file)
      result.files += 1
    } catch {
      result.missing += 1
    }
  }

  return result
}
```

`src/sync/sync.ts` を変更する。`import` に投影を足す:

```ts
import { projectEvent } from './projection'
```

`SyncResult` に投影の結果を足す:

```ts
export interface SyncResult {
  applied: number
  skipped: number
  /** 参照先が未着で投影できなかった数。次回の同期で再投影される。 */
  missing: number
  cursor: string | null
}
```

イベントを記録している箇所を、記録してから投影するように差し替える:

```ts
  let applied = 0
  let skipped = 0
  let missing = 0

  for (const id of ids) {
    const sealed = await options.storage.get(`${prefix}${id}.enc`)
    try {
      const event = await openEvent(options.keys, sealed)
      await options.db.events.put(event)
      const projected = await projectEvent({
        db: options.db,
        storage: options.storage,
        groupId: options.groupId,
        keys: options.keys,
        event,
      })
      missing += projected.missing
      applied += 1
    } catch {
      skipped += 1
    }
  }
```

戻り値も合わせる:

```ts
  return { applied, skipped, missing, cursor: newest ?? cursor }
```

既存の sync テストで `toEqual({ applied: 0, skipped: 0, cursor: null })` と書いている箇所は `toEqual({ applied: 0, skipped: 0, missing: 0, cursor: null })` に直す。

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/sync/
npm run typecheck
```

Expected: projection 8 tests、sync 11 tests がすべて green。

- [ ] **Step 5: コミット**

```bash
git add src/sync/projection.ts src/sync/sync.ts tests/sync/projection.test.ts tests/sync/sync.test.ts
git commit -m "feat(sync): project message events into the local content cache"
```

---
### Task 5: タイムライン画面 (design 03)

**Files:**
- Create: `src/ui/TimelineView.vue`
- Modify: `src/App.vue`
- Test: `tests/ui/TimelineView.test.ts`

**Interfaces:**
- Consumes: `Session`、`GroupDatabase` / `CachedMessage` / `openGroupDatabase`、`syncGroup`
- Produces: `TimelineView.vue`(props: `session: Session`、`storage: StorageProvider`。emit: `open` に `messageId: string`)

design 03 の画面。ローカルDBの `messages` を新しい順に並べ、未読バッジと同期状態を出す。

**未読は端末ローカル計算のみ**(要件書 §4.10)。`syncState.lastReadAt` より新しいメッセージを未読とする。誰が読んだかを送出する処理を書いてはならない。design 08 にある「未読 3名」という担当者向け表示は仕様から落ちているので作らない。

既存の `LoginView.vue` に合わせ、テスト用の要素には `data-test` 属性を付ける。

- [ ] **Step 1: 失敗するテストを書く**

`tests/ui/TimelineView.test.ts`:

```ts
// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import TimelineView from '../../src/ui/TimelineView.vue'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import type { Session } from '../../src/group/session'
import type { CachedMessage } from '../../src/db/group-db'

async function session(): Promise<Session> {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    userId: 'u_sato',
    displayName: '佐藤 さくら',
    role: 'member',
    scopes: ['all', 'sg_a'],
    groupKeys: new Map([['sg_a:v1', await generateAesKey()]]),
    roster: { groupId: 'midori', generation: 1, subgroups: [], members: [] },
    ecdhPrivate: new Uint8Array(0),
    ecdsaPrivate: new Uint8Array(0),
  }
}

const older: CachedMessage = {
  id: 'm_old',
  scopes: ['sg_a'],
  author: 'u_tanaka',
  at: '2026-08-05T08:02:00.000Z',
  body: '8月の予定表',
  attachments: [],
}
const newer: CachedMessage = {
  id: 'm_new',
  scopes: ['sg_a'],
  author: 'u_tanaka',
  at: '2026-08-07T09:12:00.000Z',
  body: '来週の集まりについて',
  attachments: ['f_1'],
}

let mounted: VueWrapper[] = []

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

// DB を消す前にコンポーネントを外さないと、進行中の読み取りが
// DatabaseClosedError で未処理のまま落ちる。
afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

async function mountTimeline() {
  const wrapper = mount(TimelineView, {
    props: { session: await session(), storage: new MemoryStorageProvider() },
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

describe('TimelineView', () => {
  it('shows the group name', async () => {
    const wrapper = await mountTimeline()
    expect(wrapper.text()).toContain('みどり台グループ')
  })

  it('lists cached messages newest first', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    const wrapper = await mountTimeline()
    const items = wrapper.findAll('[data-test="message"]')
    expect(items).toHaveLength(2)
    expect(items[0]?.text()).toContain('来週の集まりについて')
    expect(items[1]?.text()).toContain('8月の予定表')
  })

  it('shows an empty state when there is nothing yet', async () => {
    const wrapper = await mountTimeline()
    expect(wrapper.find('[data-test="empty"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="message"]')).toHaveLength(0)
  })

  it('counts every message as unread before anything has been read', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    const wrapper = await mountTimeline()
    expect(wrapper.find('[data-test="unread-count"]').text()).toBe('2')
  })

  it('counts only messages newer than lastReadAt as unread', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    await db.syncState.put({ key: 'lastReadAt', value: '2026-08-06T00:00:00.000Z' })
    const wrapper = await mountTimeline()
    expect(wrapper.find('[data-test="unread-count"]').text()).toBe('1')
  })

  it('marks individual messages as unread', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    await db.syncState.put({ key: 'lastReadAt', value: '2026-08-06T00:00:00.000Z' })
    const wrapper = await mountTimeline()
    const items = wrapper.findAll('[data-test="message"]')
    expect(items[0]?.attributes('data-unread')).toBe('true')
    expect(items[1]?.attributes('data-unread')).toBe('false')
  })

  it('shows an attachment indicator only for messages that have one', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.bulkPut([older, newer])
    const wrapper = await mountTimeline()
    const items = wrapper.findAll('[data-test="message"]')
    expect(items[0]?.find('[data-test="has-attachment"]').exists()).toBe(true)
    expect(items[1]?.find('[data-test="has-attachment"]').exists()).toBe(false)
  })

  it('emits open with the message id when a message is clicked', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put(newer)
    const wrapper = await mountTimeline()
    await wrapper.find('[data-test="message"]').trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual(['m_new'])
  })

  it('refreshes the list after a manual sync', async () => {
    const wrapper = await mountTimeline()
    expect(wrapper.findAll('[data-test="message"]')).toHaveLength(0)
    await openGroupDatabase('midori').messages.put(newer)
    await wrapper.find('[data-test="sync"]').trigger('click')
    // syncGroup → reload と非同期が多段なので、1ティックでは足りない
    await flushPromises()
    await flushPromises()
    expect(wrapper.findAll('[data-test="message"]')).toHaveLength(1)
  })

  it('reports a sync failure without losing the cached list', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put(newer)
    const failing = {
      capabilities: { read: true, write: false, list: false, inbox: false },
      get: () => Promise.reject(new Error('offline')),
      put: () => Promise.reject(new Error('offline')),
      delete: () => Promise.reject(new Error('offline')),
      list: () => Promise.reject(new Error('offline')),
    }
    const wrapper = mount(TimelineView, {
      props: { session: await session(), storage: failing as never },
    })
    mounted.push(wrapper)
    await flushPromises()
    await wrapper.find('[data-test="sync"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="sync-error"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="message"]')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/ui/TimelineView.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/ui/TimelineView.vue"`

- [ ] **Step 3: 実装する**

`src/ui/TimelineView.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { CachedMessage } from '../db/group-db'
import { openGroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import type { StorageProvider } from '../storage/provider'
import { syncGroup } from '../sync/sync'

const props = defineProps<{ session: Session; storage: StorageProvider }>()
const emit = defineEmits<{ open: [messageId: string] }>()

const messages = ref<CachedMessage[]>([])
const lastReadAt = ref<string | null>(null)
const syncError = ref('')
const syncing = ref(false)

const db = openGroupDatabase(props.session.groupId)

/** 未読は端末ローカル計算のみ。既読情報はどこへも送らない(要件書 §4.10)。 */
function isUnread(message: CachedMessage): boolean {
  return lastReadAt.value === null || message.at > lastReadAt.value
}

const unreadCount = computed(() => messages.value.filter(isUnread).length)

async function reload(): Promise<void> {
  try {
    // 2つを直列に await すると、呼び出し側が1ティックしか待たないときに
    // 2つ目が反映されない。まとめて解決させる。
    const [cached, state] = await Promise.all([
      db.messages.toArray(),
      db.syncState.get('lastReadAt'),
    ])
    messages.value = cached.sort((a, b) => (a.at < b.at ? 1 : -1))
    lastReadAt.value = state?.value ?? null
  } catch {
    // 端末の登録解除(設計書 §5.4)などで DB が閉じられた場合は、
    // 表示を最後の状態のまま保つ。読み取り失敗で画面を壊さない。
  }
}

async function sync(): Promise<void> {
  syncError.value = ''
  syncing.value = true
  try {
    await syncGroup({
      storage: props.storage,
      groupId: props.session.groupId,
      keys: props.session.groupKeys,
      db,
    })
  } catch {
    syncError.value = '同期できませんでした。オフラインの可能性があります。'
  } finally {
    syncing.value = false
    await reload()
  }
}

onMounted(reload)
</script>

<template>
  <section>
    <header>
      <h1>{{ session.groupName }}</h1>
      <p>{{ session.displayName }}</p>
      <p>未読 <span data-test="unread-count">{{ unreadCount }}</span></p>
      <button data-test="sync" :disabled="syncing" @click="sync">いま同期する</button>
    </header>

    <p v-if="syncError" data-test="sync-error">{{ syncError }}</p>

    <p v-if="messages.length === 0" data-test="empty">まだお知らせはありません。</p>

    <ul v-else>
      <li
        v-for="message in messages"
        :key="message.id"
        data-test="message"
        :data-unread="String(isUnread(message))"
        @click="emit('open', message.id)"
      >
        <time>{{ message.at }}</time>
        <p>{{ message.body }}</p>
        <span v-if="message.attachments.length > 0" data-test="has-attachment">添付あり</span>
      </li>
    </ul>
  </section>
</template>
```

`src/App.vue` を差し替える:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import LoginView from './ui/LoginView.vue'
import TimelineView from './ui/TimelineView.vue'
import type { Session } from './group/session'
import type { StorageProvider } from './storage/provider'
import { HttpStorageProvider } from './storage/http'

const session = ref<Session | null>(null)
const storage = ref<StorageProvider | null>(null)

function onLogin(next: Session, root: string): void {
  session.value = next
  storage.value = new HttpStorageProvider(root)
}
</script>

<template>
  <main>
    <LoginView v-if="!session || !storage" @login="onLogin" />
    <TimelineView v-else :session="session" :storage="storage" />
  </main>
</template>
```

`src/ui/LoginView.vue` の emit を、ストレージのルートも渡すように変更する:

```ts
const emit = defineEmits<{ login: [session: Session, root: string] }>()
```

そして `emit('login', session)` を `emit('login', session, connection.root)` に変更する。既存の `tests/ui/LoginView.test.ts` で `emitted('login')?.[0]` を検証している箇所は、要素が2つになるので `?.[0]?.[0]` を見るように直す。

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/ui/
npm run typecheck
```

Expected: TimelineView 10 tests、LoginView の既存テストも green。

- [ ] **Step 5: コミット**

```bash
git add src/ui/TimelineView.vue src/App.vue src/ui/LoginView.vue tests/ui/
git commit -m "feat(ui): add the timeline with locally computed unread state"
```

---

### Task 6: メッセージ詳細画面 (design 04)

**Files:**
- Create: `src/ui/MessageDetailView.vue`
- Modify: `src/App.vue`
- Test: `tests/ui/MessageDetailView.test.ts`

**Interfaces:**
- Consumes: `Session`、`CachedMessage` / `CachedFile` / `openGroupDatabase`
- Produces: `MessageDetailView.vue`(props: `session: Session`、`messageId: string`。emit: `back`)

design 04 のうち、フォーム回答を除いた部分。フォームは Phase 3。

添付は復号済みで `files` テーブルにあるので、`Blob` と `URL.createObjectURL` で表示する。**作った object URL は破棄する**(コンポーネント破棄時に `URL.revokeObjectURL`)。復号済みの画像を握ったまま解放しないとメモリを食い続ける。

この画面を開いたら `syncState.lastReadAt` を今の時刻に進める。これはローカルのみの更新で、送信は一切しない。

- [ ] **Step 1: 失敗するテストを書く**

`tests/ui/MessageDetailView.test.ts`:

```ts
// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import MessageDetailView from '../../src/ui/MessageDetailView.vue'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
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
    props: { session: await session(), messageId },
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/ui/MessageDetailView.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/ui/MessageDetailView.vue"`

- [ ] **Step 3: 実装する**

`src/ui/MessageDetailView.vue`:

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { CachedMessage } from '../db/group-db'
import { openGroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'

interface ResolvedAttachment {
  id: string
  mediaType: string
  url: string
}

const props = defineProps<{ session: Session; messageId: string }>()
const emit = defineEmits<{ back: [] }>()

const message = ref<CachedMessage | null>(null)
const attachments = ref<ResolvedAttachment[]>([])
const missingAttachments = ref<string[]>([])
const notFound = ref(false)

const db = openGroupDatabase(props.session.groupId)

function authorName(userId: string): string {
  return (
    props.session.roster.members.find((member) => member.userId === userId)?.displayName ?? '不明'
  )
}

onMounted(async () => {
  try {
    const found = await db.messages.get(props.messageId)
    if (!found) {
      notFound.value = true
      return
    }
    message.value = found

    // 添付を1件ずつ直列に待つと、呼び出し側が待つティック数に依存して
    // 表示が欠ける。既読の記録も含めて1段にまとめる。
    // 既読はローカルにだけ記録する。送出は一切しない(要件書 §4.10)。
    const [files] = await Promise.all([
      Promise.all(found.attachments.map((fileId) => db.files.get(fileId))),
      db.syncState.put({ key: 'lastReadAt', value: new Date().toISOString() }),
    ])

    found.attachments.forEach((fileId, index) => {
      const file = files[index]
      if (!file) {
        missingAttachments.value.push(fileId)
        return
      }
      const blob = new Blob([file.blob], { type: file.mediaType })
      attachments.value.push({
        id: fileId,
        mediaType: file.mediaType,
        url: URL.createObjectURL(blob),
      })
    })
  } catch {
    // 端末の登録解除(設計書 §5.4)などで DB が閉じられた場合。画面は壊さない。
  }
})

onBeforeUnmount(() => {
  for (const attachment of attachments.value) {
    URL.revokeObjectURL(attachment.url)
  }
})
</script>

<template>
  <section>
    <button data-test="back" @click="emit('back')">戻る</button>

    <p v-if="notFound" data-test="not-found">このお知らせは見つかりませんでした。</p>

    <article v-else-if="message">
      <p>{{ authorName(message.author) }}・{{ message.at }}</p>
      <p data-test="body">{{ message.body }}</p>

      <div v-for="attachment in attachments" :key="attachment.id">
        <img
          v-if="attachment.mediaType.startsWith('image/')"
          data-test="attachment-image"
          :src="attachment.url"
          alt=""
        />
        <a v-else data-test="attachment-link" :href="attachment.url" download>添付を開く</a>
      </div>

      <p v-for="fileId in missingAttachments" :key="fileId" data-test="attachment-missing">
        添付はまだ受信できていません。
      </p>
    </article>
  </section>
</template>
```

`src/App.vue` に詳細画面への遷移を足す:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import LoginView from './ui/LoginView.vue'
import TimelineView from './ui/TimelineView.vue'
import MessageDetailView from './ui/MessageDetailView.vue'
import type { Session } from './group/session'
import type { StorageProvider } from './storage/provider'
import { HttpStorageProvider } from './storage/http'

const session = ref<Session | null>(null)
const storage = ref<StorageProvider | null>(null)
const openMessageId = ref<string | null>(null)

function onLogin(next: Session, root: string): void {
  session.value = next
  storage.value = new HttpStorageProvider(root)
}
</script>

<template>
  <main>
    <LoginView v-if="!session || !storage" @login="onLogin" />
    <MessageDetailView
      v-else-if="openMessageId"
      :session="session"
      :message-id="openMessageId"
      @back="openMessageId = null"
    />
    <TimelineView v-else :session="session" :storage="storage" @open="openMessageId = $event" />
  </main>
</template>
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/ui/
npm run typecheck
```

Expected: MessageDetailView 10 tests が green、既存の UI テストも green。

- [ ] **Step 5: コミット**

```bash
git add src/ui/MessageDetailView.vue src/App.vue tests/ui/MessageDetailView.test.ts
git commit -m "feat(ui): add the message detail screen with decrypted attachments"
```

---

### Task 7: 投稿作成画面 (design 06)

**Files:**
- Create: `src/ui/ComposeView.vue`
- Modify: `src/App.vue`
- Test: `tests/ui/ComposeView.test.ts`

**Interfaces:**
- Consumes: Task 3 の `Draft` / `createPost` / `PostError`、`Session`、`openGroupDatabase`、`flushOutbox`
- Produces: `ComposeView.vue`(props: `session: Session`、`storage: StorageProvider`。emit: `posted`、`cancel`)

design 06 の画面。フォーム埋め込みは Phase 3 なので、本文・宛先の複数選択・添付までを作る。

宛先は `session.roster.subgroups` と `session.scopes` の交差から選択肢を作る。**自分が鍵を持っているスコープしか選べない**ようにする(持っていないスコープを選べると Task 3 で例外になり、ユーザーには理由が分からない)。

送信は `createPost` で outbox に積んでから `flushOutbox` を試す。オフラインでも投稿は成立し、キューに残る。

- [ ] **Step 1: 失敗するテストを書く**

`tests/ui/ComposeView.test.ts`:

```ts
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/ui/ComposeView.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/ui/ComposeView.vue"`

- [ ] **Step 3: 実装する**

`src/ui/ComposeView.vue`:

```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import { createPost } from '../content/post'
import type { DraftAttachment } from '../content/post'
import { openGroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import { ALL_SCOPE } from '../crypto/roster'
import type { StorageProvider } from '../storage/provider'
import { flushOutbox } from '../sync/outbox'

const props = defineProps<{ session: Session; storage: StorageProvider }>()
const emit = defineEmits<{ posted: []; cancel: [] }>()

const body = ref('')
const selected = ref<Record<string, boolean>>({})
const attachments = ref<DraftAttachment[]>([])
const error = ref('')
const queued = ref(false)
const busy = ref(false)

const db = openGroupDatabase(props.session.groupId)

const canPost = computed(() => props.session.role !== 'member')

/** 鍵を持っているスコープだけを選択肢にする。staff スコープは配信先ではない。 */
const options = computed(() => {
  const held = new Set(
    [...props.session.groupKeys.keys()].map((id) => id.slice(0, id.lastIndexOf(':v'))),
  )
  const list: { id: string; label: string }[] = []
  if (held.has(ALL_SCOPE)) list.push({ id: ALL_SCOPE, label: 'グループ全体' })
  for (const subgroup of props.session.roster.subgroups) {
    if (held.has(subgroup.id)) list.push({ id: subgroup.id, label: subgroup.name })
  }
  return list
})

async function submit(): Promise<void> {
  error.value = ''
  queued.value = false
  busy.value = true
  try {
    const scopes = Object.entries(selected.value)
      .filter(([, on]) => on)
      .map(([id]) => id)
    await createPost({
      session: props.session,
      db,
      draft: { body: body.value, scopes, attachments: attachments.value },
    })
    // flushOutbox は失敗しても例外を投げず、失敗件数を返す
    const flushed = await flushOutbox({ db, storage: props.storage })
    if (flushed.failed > 0) {
      queued.value = true
    } else {
      emit('posted')
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '送信できませんでした'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section>
    <p v-if="!canPost" data-test="not-allowed">投稿できるのは担当者と管理者だけです。</p>

    <form v-else @submit.prevent="submit">
      <fieldset>
        <legend>届ける相手</legend>
        <label v-for="option in options" :key="option.id">
          <input
            type="checkbox"
            data-test="scope-option"
            :data-scope="option.id"
            :value="option.id"
            v-model="selected[option.id]"
          />
          {{ option.label }}
        </label>
      </fieldset>

      <textarea data-test="body" v-model="body"></textarea>

      <p v-if="error" data-test="error">{{ error }}</p>
      <p v-if="queued" data-test="queued">
        オフラインのため送信待ちにしました。オンラインに戻ると自動で送信されます。
      </p>

      <button type="button" data-test="cancel" @click="emit('cancel')">キャンセル</button>
      <button type="button" data-test="submit" :disabled="busy" @click="submit">送信する</button>
    </form>
  </section>
</template>
```

`data-test` を2つ付けているのは、「選択肢の一覧を取る」用途と「特定のスコープを選ぶ」用途の両方が要るため。Vue は同名属性の重複を許さないので、テスト側は `[data-test="scope-option"]` で列挙し、個別操作には `[data-test="scope-option"][data-scope="sg_a"]` を使う。**実装時に両方が DOM に出ていることを必ず確認すること**(片方しか出ていないとテストの半分が無言で通らなくなる)。出せない場合は `data-test="scope-option"` と `data-scope="sg_a"` の2属性に分け、テスト側のセレクタを `[data-test="scope-option"][data-scope="sg_a"]` に直す。

`src/App.vue` に投稿画面への導線を足す。担当者のときだけ「お知らせを作る」ボタンを出す:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import LoginView from './ui/LoginView.vue'
import TimelineView from './ui/TimelineView.vue'
import MessageDetailView from './ui/MessageDetailView.vue'
import ComposeView from './ui/ComposeView.vue'
import type { Session } from './group/session'
import type { StorageProvider } from './storage/provider'
import { HttpStorageProvider } from './storage/http'

const session = ref<Session | null>(null)
const storage = ref<StorageProvider | null>(null)
const openMessageId = ref<string | null>(null)
const composing = ref(false)

function onLogin(next: Session, root: string): void {
  session.value = next
  storage.value = new HttpStorageProvider(root)
}
</script>

<template>
  <main>
    <LoginView v-if="!session || !storage" @login="onLogin" />
    <ComposeView
      v-else-if="composing"
      :session="session"
      :storage="storage"
      @posted="composing = false"
      @cancel="composing = false"
    />
    <MessageDetailView
      v-else-if="openMessageId"
      :session="session"
      :message-id="openMessageId"
      @back="openMessageId = null"
    />
    <template v-else>
      <button v-if="session.role !== 'member'" data-test="compose" @click="composing = true">
        お知らせを作る
      </button>
      <TimelineView :session="session" :storage="storage" @open="openMessageId = $event" />
    </template>
  </main>
</template>
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run
npm run typecheck
npm run build
```

Expected: 全テスト green、型チェックエラーなし、ビルド成功。

- [ ] **Step 5: コミット**

```bash
git add src/ui/ComposeView.vue src/App.vue tests/ui/ComposeView.test.ts
git commit -m "feat(ui): add the compose screen with multi-scope delivery"
```

---

## Phase 2b 完了条件

- `npm run test:run` が全て green
- `npm run typecheck` がエラーなし
- `npm run build` が成功する
- 「担当者が複数スコープ宛に投稿 → 別端末で同期 → タイムラインに現れる → 詳細で添付が見える」が Task 4 の統合テストと Task 5-7 の画面テストで通っている
- 既読情報を送出するコードが1行も無い(要件書 §4.10)

## 次フェーズへの引き継ぎ

Phase 2b で実装していない作業:

- **添付の重複排除**(設計書 §4.5)。`AttachmentRef.contentHash` は記録済みなので、同一スコープ内で同じハッシュの `fileId` を再利用する処理を後から足せる。今フェーズでは毎回新しいオブジェクトを作る
- **`files` テーブルの LRU 上限**(設計書 §6.5)。今は無制限にキャッシュする
- inbox(上り経路)、不在連絡、メールアドレス必須フロー → Phase 2c
- mailto 通知、開設ウィザード、リカバリキット → Phase 2d
- フォーム埋め込みと回答集計 → Phase 3
- `S3StorageProvider` を使う経路。現状 `LoginView` は `HttpStorageProvider` 固定で、書き込みは `MemoryStorageProvider` を渡すテストでしか通っていない。実バケットへの書き込みは Phase 2d の開設ウィザードで `settings/storage.enc` を読んでから繋ぐ

## 実装前に確認すること

- Task 5 で `LoginView` の emit シグネチャを変えるため、既存の `tests/ui/LoginView.test.ts` が壊れる。Task 5 の Step 3 に書いたとおり直すこと
- Task 4 で `SyncResult` に `missing` を足すため、既存の `tests/sync/sync.test.ts` の `toEqual` が1箇所壊れる。同じく Step 3 に記載済み
