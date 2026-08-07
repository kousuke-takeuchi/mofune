# Phase 2f: 開設ウィザードとリカバリキット 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理者がアプリだけでグループを開設できるようにする。ストレージの接続を確認し、書き込み資格情報を保存し、紙のリカバリキットを出すところまでを1つの流れにする。これが終わると実バケットで一周できる。

**Architecture:** 開設は「入力 → 接続確認 → 書き込み → リカバリキット」の順に進む。**接続確認に成功するまで書き込まない。** 資格情報が誤ったまま開設すると、参加者が読めないグループができてしまい、紙を配り直すまで復旧できない。管理者のルート鍵は失うと名簿を再署名できなくなるため、開設の最後に紙へ出す手順を必須にする(設計書 §4.8)。

**Tech Stack:** Vue 3 / TypeScript / Vite / Vitest / Dexie.js / Web Crypto API

正は [要件書](../../Mofune%20-%20要件書.md) / [設計書](../../Mofune%20-%20設計書.md)。Phase 1〜2e の成果物の上に載る。

## Global Constraints

Phase 1〜2e の Global Constraints をすべて引き継ぐ。特に:

- 暗号プリミティブは Web Crypto API のみ。例外は Argon2id (hash-wasm) のみ
- **バイト列の型は `Bytes`**(= `Uint8Array<ArrayBuffer>`)。型注釈上の `Uint8Array` は `Bytes` と読み替え、テストの `as Uint8Array` も `as Bytes` にする
- **`noUnusedLocals` が有効。** 各タスクで `npm run typecheck` まで通してからコミットする
- 秘密鍵・パスワード・ストレージ資格情報を IndexedDB / localStorage に保存してはならない
- 参加者からの上りに staff スコープ鍵を使ってはならない(設計書 §4.6)
- 通知経路に本文・個人情報を載せてはならない
- ストレージパスを組み立てる箇所は `assertSafePath` を通す
- **UI テストの待機は `vi.waitFor` で「実際に検証したい条件」を待つ**
- 本番の KDF パラメータをテストで使わない。テストは `TEST_KDF`
- `tsconfig.json` は `strict: true` と `verbatimModuleSyntax: true`
- テストは `tests/**/*.test.ts`。`import { describe, it, expect } from 'vitest'` を明示する
- DOM が要るテストはファイル先頭に `// @vitest-environment happy-dom`
- コミットは Conventional Commits 形式。`Co-Authored-By` 行は付けない
- 実行時に外部CDNへ接続しない

## 既存インターフェース(実装前に確認済み)

```ts
// src/group/provision.ts
interface NewMember { loginId; displayName; role: Role; scopes: string[]; password: string; email: string }
interface ProvisionOptions { groupId; groupName; provider: ProviderKind; root: string; subgroups: Subgroup[]; members: NewMember[]; kdf?: KdfParams }
interface ProvisionResult { code: ConnectionCode; objects: Map<string, Bytes> }
provisionGroup(options: ProvisionOptions): Promise<ProvisionResult>
writeObjects(storage: StorageProvider, objects: Map<string, Bytes>): Promise<void>
const INITIAL_GENERATION = 1

// src/group/connection-code.ts
interface ConnectionCode { v; groupId; provider: ProviderKind; root; pepper; adminPublicKey }
encodeConnectionCode(code: ConnectionCode): string
type ProviderKind = 'http' | 's3' | 'gdrive' | 'dropbox' | 'webdav'

// src/group/storage-credentials.ts
interface StorageSettings { provider: 's3'; endpoint; region; bucket; accessKeyId; secretAccessKey }
writeStorageSettings(options: { storage; groupId; settings; staffKey; generation }): Promise<void>
toProviderConfig(settings: StorageSettings): S3ProviderConfig

// src/group/group-settings.ts
interface GroupSettings { v; mailTemplate: MailTemplate; absenceReasons: string[]; notifications: NotificationSettings }
const DEFAULT_GROUP_SETTINGS
readGroupSettings(options: { storage; groupId; staffKey }): Promise<GroupSettings>
writeGroupSettings(options: { storage; groupId; settings; staffKey; generation }): Promise<void>

// src/crypto/keystore.ts
interface KeystoreContents { userId: string; ecdh: RawKeyPair; ecdsa: RawKeyPair }
createKeystore(contents, password, pepper, params?): Promise<KeystoreFile>
unlockKeystore(file, password, pepper): Promise<KeystoreContents>

// src/crypto/asymmetric.ts
interface RawKeyPair { publicKey: Bytes; privateKey: Bytes }

// src/crypto/keyring.ts
keyId(scope: string, generation: number): string

// src/storage/s3.ts
class S3StorageProvider implements StorageProvider { constructor(config: S3ProviderConfig) }

// src/storage/provider.ts
class NotFoundError extends Error {}; class UnsupportedOperationError extends Error {}

// src/inbox/grants.ts
publishGrants(options: { storage; groupId; roster; settings; now? }): Promise<string[]>
```

## File Structure

```
src/crypto/base32.ts          手書き転記に耐える符号化                    Task 1
src/group/recovery-kit.ts     管理者ルート鍵の紙バックアップ              Task 2
src/group/connection-check.ts ストレージの接続確認                        Task 3
src/group/setup.ts            開設の一連の流れ                            Task 4
src/ui/ProvisionWizardView.vue 開設ウィザード (design 10)                 Task 5
src/App.vue                   未ログイン時の導線(既存を変更)            Task 5
```

---

### Task 1: 手書き転記に耐える符号化

**Files:**
- Create: `src/crypto/base32.ts`
- Test: `tests/crypto/base32.test.ts`

**Interfaces:**
- Consumes: `Bytes`
- Produces: `class Base32Error extends Error`、`const BASE32_ALPHABET`、`toBase32(bytes: Bytes): string` / `fromBase32(text: string): Bytes` / `groupForPrinting(text: string, groupSize?: number, perLine?: number): string`

リカバリキットは紙に印刷して人が読み書きする。base64 は大小文字と `+/=` が混ざり、転記事故が起きやすい。**Crockford Base32** を使う。

- 記号は `0123456789ABCDEFGHJKMNPQRSTVWXYZ` の32文字。`I` `L` `O` `U` を含まない
- 読むときは大小を区別せず、`O` を `0`、`I` と `L` を `1` として受け入れる。人は必ず間違える
- ハイフンと空白は無視する。印刷時に読みやすく区切るため

`groupForPrinting` は4文字ごとにハイフン、指定数ごとに改行を入れる。目で追える形にするのが目的。

- [ ] **Step 1: 失敗するテストを書く**

`tests/crypto/base32.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BASE32_ALPHABET, Base32Error, fromBase32, groupForPrinting, toBase32 } from '../../src/crypto/base32'
import { utf8, fromUtf8, toHex } from '../../src/crypto/bytes'

describe('BASE32_ALPHABET', () => {
  it('has 32 symbols', () => {
    expect(BASE32_ALPHABET).toHaveLength(32)
  })

  it('leaves out the letters people confuse with digits', () => {
    for (const letter of ['I', 'L', 'O', 'U']) {
      expect(BASE32_ALPHABET).not.toContain(letter)
    }
  })
})

describe('toBase32 / fromBase32', () => {
  it('round-trips an empty input', () => {
    expect(fromBase32(toBase32(new Uint8Array(0)))).toEqual(new Uint8Array(0))
  })

  it('round-trips a short input', () => {
    const input = utf8('mofune')
    expect(fromUtf8(fromBase32(toBase32(input)))).toBe('mofune')
  })

  it('round-trips arbitrary bytes at every length up to 40', () => {
    for (let length = 0; length <= 40; length += 1) {
      const input = new Uint8Array(length)
      for (let i = 0; i < length; i += 1) input[i] = (i * 37 + 11) % 256
      expect(toHex(fromBase32(toBase32(input)))).toBe(toHex(input))
    }
  })

  it('produces only alphabet symbols', () => {
    const input = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    for (const ch of toBase32(input)) {
      expect(BASE32_ALPHABET).toContain(ch)
    }
  })

  it('reads lower case back', () => {
    const input = utf8('mofune')
    expect(fromUtf8(fromBase32(toBase32(input).toLowerCase()))).toBe('mofune')
  })

  it('forgives the letters people mistype', () => {
    const encoded = toBase32(utf8('mofune'))
    const mistyped = encoded.replace(/0/g, 'O').replace(/1/g, 'I')
    expect(toHex(fromBase32(mistyped))).toBe(toHex(fromBase32(encoded)))
  })

  it('ignores hyphens and whitespace', () => {
    const encoded = toBase32(utf8('mofune'))
    const spaced = groupForPrinting(encoded)
    expect(toHex(fromBase32(spaced))).toBe(toHex(fromBase32(encoded)))
  })

  it('rejects a symbol outside the alphabet', () => {
    expect(() => fromBase32('ABC$')).toThrow(Base32Error)
  })
})

describe('groupForPrinting', () => {
  it('inserts a hyphen every four characters', () => {
    expect(groupForPrinting('ABCDEFGH', 4, 100)).toBe('ABCD-EFGH')
  })

  it('breaks lines after the requested number of groups', () => {
    expect(groupForPrinting('ABCDEFGHIJKL', 4, 2)).toBe('ABCD-EFGH\nIJKL')
  })

  it('does not leave a trailing separator', () => {
    const printed = groupForPrinting('ABCDEF', 4, 100)
    expect(printed.endsWith('-')).toBe(false)
    expect(printed).toBe('ABCD-EF')
  })

  it('returns an empty string unchanged', () => {
    expect(groupForPrinting('')).toBe('')
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/crypto/base32.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/crypto/base32"`

- [ ] **Step 3: 実装する**

`src/crypto/base32.ts`:

```ts
import type { Bytes } from './bytes'

export class Base32Error extends Error {}

/**
 * Crockford Base32。I / L / O / U を含まないので、手書きの転記で
 * 0 と O、1 と I を取り違える事故が起きにくい。
 */
export const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function toBase32(bytes: Bytes): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  }
  return out
}

/** 人は必ず間違えるので、紛らわしい字は受け入れて読み替える。 */
function symbolValue(ch: string): number {
  const upper = ch.toUpperCase()
  if (upper === 'O') return 0
  if (upper === 'I' || upper === 'L') return 1
  const index = BASE32_ALPHABET.indexOf(upper)
  if (index < 0) {
    throw new Base32Error(`"${ch}" is not a base32 symbol`)
  }
  return index
}

export function fromBase32(text: string): Bytes {
  const cleaned = text.replace(/[-\s]/g, '')
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of cleaned) {
    buffer = (buffer << 5) | symbolValue(ch)
    bits += 5
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** 印刷して目で追えるよう、区切りと改行を入れる。 */
export function groupForPrinting(text: string, groupSize = 4, perLine = 8): string {
  if (text.length === 0) return ''
  const groups: string[] = []
  for (let i = 0; i < text.length; i += groupSize) {
    groups.push(text.slice(i, i + groupSize))
  }
  const lines: string[] = []
  for (let i = 0; i < groups.length; i += perLine) {
    lines.push(groups.slice(i, i + perLine).join('-'))
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/crypto/base32.test.ts && npm run typecheck
```

Expected: 14 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/crypto/base32.ts tests/crypto/base32.test.ts
git commit -m "feat(crypto): add crockford base32 for hand-transcribed backups"
```

---

### Task 2: 管理者ルート鍵の紙バックアップ

**Files:**
- Create: `src/group/recovery-kit.ts`
- Test: `tests/group/recovery-kit.test.ts`

**Interfaces:**
- Consumes: Task 1 の `toBase32` / `fromBase32` / `groupForPrinting`、`KeystoreContents`、`RawKeyPair`、`Bytes` / `toBase64` / `fromBase64` / `fromUtf8` / `utf8`、`sha256`
- Produces: `class RecoveryKitError extends Error`、`const RECOVERY_KIT_VERSION`、`interface RecoveryKit { groupId: string; groupName: string; userId: string; code: string; checksum: string }`、`buildRecoveryKit(options: { groupId: string; groupName: string; contents: KeystoreContents }): Promise<RecoveryKit>` / `parseRecoveryKit(text: string): Promise<{ groupId: string; userId: string; contents: KeystoreContents }>`

設計書 §4.8 の実装。**管理者のルート鍵を失うと、名簿を二度と再署名できない。** メンバーの追加・削除・連絡先の反映がすべて止まり、グループを作り直すしかなくなる。だから開設手順に紙の保管を組み込む。

**この紙は平文の鍵そのものである。** 暗号化して「復号用のコードも同じ紙に印刷する」のは、鍵を鍵と一緒に置くのと同じで意味がない。**セキュリティは紙の物理的な管理に依存する**という事実をそのまま受け入れ、画面と印刷物に明記する。パスフレーズで保護したいなら、それは利用者が別途保管する運用であり、今フェーズでは扱わない。

**チェックサムを付ける。** 転記を間違えたまま「復元できた」と誤認すると、後になって署名が通らない形で発覚する。読み込み時に必ず検証する。

- [ ] **Step 1: 失敗するテストを書く**

`tests/group/recovery-kit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { RecoveryKitError, buildRecoveryKit, parseRecoveryKit } from '../../src/group/recovery-kit'
import { generateEcdhKeyPair, generateEcdsaKeyPair } from '../../src/crypto/asymmetric'
import { toHex } from '../../src/crypto/bytes'
import type { KeystoreContents } from '../../src/crypto/keystore'

async function contents(): Promise<KeystoreContents> {
  return {
    userId: 'u_0123456789abcdef',
    ecdh: await generateEcdhKeyPair(),
    ecdsa: await generateEcdsaKeyPair(),
  }
}

const meta = { groupId: 'midori', groupName: 'みどり台グループ' }

describe('buildRecoveryKit', () => {
  it('carries the group and user it belongs to', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    expect(kit.groupId).toBe('midori')
    expect(kit.groupName).toBe('みどり台グループ')
    expect(kit.userId).toBe('u_0123456789abcdef')
  })

  it('prints the code in readable groups', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    expect(kit.code).toContain('-')
    expect(kit.code).toContain('\n')
  })

  it('includes a checksum', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    expect(kit.checksum.length).toBeGreaterThan(0)
  })

  it('produces a different code for a different key', async () => {
    const a = await buildRecoveryKit({ ...meta, contents: await contents() })
    const b = await buildRecoveryKit({ ...meta, contents: await contents() })
    expect(a.code).not.toBe(b.code)
  })
})

describe('parseRecoveryKit', () => {
  it('restores the exact key material', async () => {
    const original = await contents()
    const kit = await buildRecoveryKit({ ...meta, contents: original })
    const restored = await parseRecoveryKit(kit.code)
    expect(restored.userId).toBe(original.userId)
    expect(toHex(restored.contents.ecdsa.privateKey)).toBe(toHex(original.ecdsa.privateKey))
    expect(toHex(restored.contents.ecdsa.publicKey)).toBe(toHex(original.ecdsa.publicKey))
    expect(toHex(restored.contents.ecdh.privateKey)).toBe(toHex(original.ecdh.privateKey))
    expect(toHex(restored.contents.ecdh.publicKey)).toBe(toHex(original.ecdh.publicKey))
  })

  it('restores the group it belongs to', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    expect((await parseRecoveryKit(kit.code)).groupId).toBe('midori')
  })

  it('accepts a code typed without the separators', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    const flat = kit.code.replace(/[-\s]/g, '')
    expect((await parseRecoveryKit(flat)).groupId).toBe('midori')
  })

  it('accepts a code typed in lower case', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    expect((await parseRecoveryKit(kit.code.toLowerCase())).groupId).toBe('midori')
  })

  it('rejects a code with a mistyped character', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    const flat = kit.code.replace(/[-\s]/g, '')
    // 1文字だけ別の記号に置き換える
    const broken = (flat[0] === '2' ? '3' : '2') + flat.slice(1)
    await expect(parseRecoveryKit(broken)).rejects.toThrow(RecoveryKitError)
  })

  it('rejects a truncated code', async () => {
    const kit = await buildRecoveryKit({ ...meta, contents: await contents() })
    const flat = kit.code.replace(/[-\s]/g, '')
    await expect(parseRecoveryKit(flat.slice(0, -8))).rejects.toThrow(RecoveryKitError)
  })

  it('rejects text that is not a recovery kit', async () => {
    await expect(parseRecoveryKit('HELLO')).rejects.toThrow(RecoveryKitError)
  })

  it('rejects an empty code', async () => {
    await expect(parseRecoveryKit('')).rejects.toThrow(RecoveryKitError)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/group/recovery-kit.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/group/recovery-kit"`

- [ ] **Step 3: 実装する**

`src/group/recovery-kit.ts`:

```ts
import { fromBase32, groupForPrinting, toBase32 } from '../crypto/base32'
import type { Bytes } from '../crypto/bytes'
import { fromBase64, fromUtf8, toBase64, toHex, utf8 } from '../crypto/bytes'
import type { KeystoreContents } from '../crypto/keystore'
import { sha256 } from '../crypto/symmetric'

export class RecoveryKitError extends Error {}

export const RECOVERY_KIT_VERSION = 1
/** チェックサムに使う先頭バイト数。転記ミスを見つけられれば十分。 */
const CHECKSUM_BYTES = 4

export interface RecoveryKit {
  groupId: string
  groupName: string
  userId: string
  /** 印刷用に区切った base32。 */
  code: string
  /** 目視確認用の16進チェックサム。 */
  checksum: string
}

interface KitPayload {
  v: number
  groupId: string
  groupName: string
  userId: string
  ecdhPublic: string
  ecdhPrivate: string
  ecdsaPublic: string
  ecdsaPrivate: string
}

async function checksumOf(body: Bytes): Promise<Bytes> {
  return (await sha256(body)).slice(0, CHECKSUM_BYTES)
}

/**
 * 管理者のルート鍵を紙に出せる形にする。
 *
 * この紙は鍵そのものであり、暗号化していない。復号コードを同じ紙に印刷しても
 * 意味がないためで、安全性は紙の物理的な管理に依存する。画面と印刷物に明記すること。
 */
export async function buildRecoveryKit(options: {
  groupId: string
  groupName: string
  contents: KeystoreContents
}): Promise<RecoveryKit> {
  const payload: KitPayload = {
    v: RECOVERY_KIT_VERSION,
    groupId: options.groupId,
    groupName: options.groupName,
    userId: options.contents.userId,
    ecdhPublic: toBase64(options.contents.ecdh.publicKey),
    ecdhPrivate: toBase64(options.contents.ecdh.privateKey),
    ecdsaPublic: toBase64(options.contents.ecdsa.publicKey),
    ecdsaPrivate: toBase64(options.contents.ecdsa.privateKey),
  }
  const body = utf8(JSON.stringify(payload))
  const checksum = await checksumOf(body)

  const full = new Uint8Array(body.length + checksum.length)
  full.set(body, 0)
  full.set(checksum, body.length)

  return {
    groupId: options.groupId,
    groupName: options.groupName,
    userId: options.contents.userId,
    code: groupForPrinting(toBase32(full)),
    checksum: toHex(checksum),
  }
}

export async function parseRecoveryKit(
  text: string,
): Promise<{ groupId: string; userId: string; contents: KeystoreContents }> {
  let decoded: Bytes
  try {
    decoded = fromBase32(text)
  } catch {
    throw new RecoveryKitError('the recovery code contains characters that are not valid')
  }
  if (decoded.length <= CHECKSUM_BYTES) {
    throw new RecoveryKitError('the recovery code is too short')
  }

  const body = decoded.slice(0, decoded.length - CHECKSUM_BYTES)
  const given = decoded.slice(decoded.length - CHECKSUM_BYTES)
  const expected = await checksumOf(body)
  if (toHex(given) !== toHex(expected)) {
    // 転記ミスに気づかせる。誤ったまま「復元できた」と思わせるほうが危険。
    throw new RecoveryKitError('the recovery code does not match its checksum; check for typos')
  }

  let payload: KitPayload
  try {
    payload = JSON.parse(fromUtf8(body)) as KitPayload
  } catch {
    throw new RecoveryKitError('the recovery code does not contain a recovery kit')
  }
  if (payload.v !== RECOVERY_KIT_VERSION || typeof payload.userId !== 'string') {
    throw new RecoveryKitError('unsupported recovery kit version')
  }

  return {
    groupId: payload.groupId,
    userId: payload.userId,
    contents: {
      userId: payload.userId,
      ecdh: {
        publicKey: fromBase64(payload.ecdhPublic),
        privateKey: fromBase64(payload.ecdhPrivate),
      },
      ecdsa: {
        publicKey: fromBase64(payload.ecdsaPublic),
        privateKey: fromBase64(payload.ecdsaPrivate),
      },
    },
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/group/recovery-kit.test.ts && npm run typecheck
```

Expected: 12 tests passed、型チェックはエラーなし。

`rejects a code with a mistyped character` が落ちる場合、置き換えた1文字がたまたま同じ値に読み替えられている可能性がある(`0`↔`O` など)。その場合はテスト側で、`BASE32_ALPHABET` 上で確実に異なる記号を選ぶよう直す。

- [ ] **Step 5: コミット**

```bash
git add src/group/recovery-kit.ts tests/group/recovery-kit.test.ts
git commit -m "feat(group): print and read back the admin root key recovery kit"
```

---

### Task 3: ストレージの接続確認

**Files:**
- Create: `src/group/connection-check.ts`
- Test: `tests/group/connection-check.test.ts`

**Interfaces:**
- Consumes: `StorageSettings` / `toProviderConfig`、`S3StorageProvider`、`StorageProvider`、`Bytes` / `fromUtf8` / `toHex` / `utf8`、`randomBytes`
- Produces: `interface CheckStep { name: string; ok: boolean; detail: string }`、`interface CheckResult { ok: boolean; steps: CheckStep[] }`、`checkConnection(options: { storage: StorageProvider; groupId: string }): Promise<CheckResult>`

design 10 の「接続の確認」。**書き込む前に確かめる。** 資格情報や CORS が誤ったまま開設すると、参加者が読めないグループができ、紙を配り直すまで復旧できない。

確かめるのは3つ。

1. **書き込める** — テスト用のオブジェクトを PUT する
2. **読み戻せる** — 書いた内容がそのまま返る(CORS と公開読みの確認を兼ねる)
3. **消せる** — 後片付けができる。できないと確認のたびにゴミが残る

**例外を投げずに結果を返す。** どの段階で失敗したかを画面に出したいので、途中で throw すると何が悪いか分からなくなる。

テスト用オブジェクトのキーはランダムにし、確認後に必ず消す。

- [ ] **Step 1: 失敗するテストを書く**

`tests/group/connection-check.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { checkConnection } from '../../src/group/connection-check'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { UnsupportedOperationError } from '../../src/storage/provider'
import type { StorageProvider } from '../../src/storage/provider'
import type { Bytes } from '../../src/crypto/bytes'

function failingAt(stage: 'put' | 'get' | 'delete'): StorageProvider {
  const inner = new MemoryStorageProvider()
  return {
    capabilities: inner.capabilities,
    put: (path: string, data: Bytes) =>
      stage === 'put' ? Promise.reject(new Error('denied')) : inner.put(path, data),
    get: (path: string) =>
      stage === 'get' ? Promise.reject(new Error('cors')) : inner.get(path),
    delete: (path: string) =>
      stage === 'delete'
        ? Promise.reject(new UnsupportedOperationError('read-only'))
        : inner.delete(path),
    list: (prefix: string, after?: string) => inner.list(prefix, after),
  }
}

describe('checkConnection', () => {
  it('passes every step against a working provider', async () => {
    const result = await checkConnection({ storage: new MemoryStorageProvider(), groupId: 'midori' })
    expect(result.ok).toBe(true)
    expect(result.steps.every((step) => step.ok)).toBe(true)
  })

  it('reports the three steps it checks', async () => {
    const result = await checkConnection({ storage: new MemoryStorageProvider(), groupId: 'midori' })
    expect(result.steps).toHaveLength(3)
    expect(result.steps.map((step) => step.name)).toEqual(['write', 'read', 'delete'])
  })

  it('leaves nothing behind when it succeeds', async () => {
    const storage = new MemoryStorageProvider()
    await checkConnection({ storage, groupId: 'midori' })
    expect(await storage.list('midori/')).toHaveLength(0)
  })

  it('fails at the write step when the credentials are wrong', async () => {
    const result = await checkConnection({ storage: failingAt('put'), groupId: 'midori' })
    expect(result.ok).toBe(false)
    expect(result.steps[0]).toMatchObject({ name: 'write', ok: false })
  })

  it('does not attempt the later steps once writing fails', async () => {
    const result = await checkConnection({ storage: failingAt('put'), groupId: 'midori' })
    expect(result.steps).toHaveLength(1)
  })

  it('fails at the read step when the object cannot be fetched back', async () => {
    const result = await checkConnection({ storage: failingAt('get'), groupId: 'midori' })
    expect(result.ok).toBe(false)
    expect(result.steps.map((step) => step.name)).toEqual(['write', 'read'])
    expect(result.steps[1]?.ok).toBe(false)
  })

  it('fails at the delete step when cleanup is not allowed', async () => {
    const result = await checkConnection({ storage: failingAt('delete'), groupId: 'midori' })
    expect(result.ok).toBe(false)
    expect(result.steps[2]).toMatchObject({ name: 'delete', ok: false })
  })

  it('explains what went wrong rather than throwing', async () => {
    const result = await checkConnection({ storage: failingAt('put'), groupId: 'midori' })
    expect(result.steps[0]?.detail.length).toBeGreaterThan(0)
  })

  it('detects storage that returns different bytes than were written', async () => {
    const inner = new MemoryStorageProvider()
    const lying: StorageProvider = {
      capabilities: inner.capabilities,
      put: (path, data) => inner.put(path, data),
      get: async () => new TextEncoder().encode('something else') as Bytes,
      delete: (path) => inner.delete(path),
      list: (prefix, after) => inner.list(prefix, after),
    }
    const result = await checkConnection({ storage: lying, groupId: 'midori' })
    expect(result.ok).toBe(false)
    expect(result.steps[1]?.ok).toBe(false)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/group/connection-check.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/group/connection-check"`

- [ ] **Step 3: 実装する**

`src/group/connection-check.ts`:

```ts
import { fromUtf8, toHex, utf8 } from '../crypto/bytes'
import { randomBytes } from '../crypto/symmetric'
import type { StorageProvider } from '../storage/provider'

export interface CheckStep {
  name: string
  ok: boolean
  detail: string
}

export interface CheckResult {
  ok: boolean
  steps: CheckStep[]
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * 書き込む前にストレージを確かめる。
 *
 * 資格情報や CORS が誤ったまま開設すると、参加者が読めないグループができ、
 * 紙を配り直すまで復旧できない。例外を投げず、どの段階で失敗したかを返す。
 */
export async function checkConnection(options: {
  storage: StorageProvider
  groupId: string
}): Promise<CheckResult> {
  const steps: CheckStep[] = []
  const probe = `${options.groupId}/.connection-check-${toHex(randomBytes(8))}`
  const payload = utf8(`mofune connection check ${new Date().toISOString()}`)

  try {
    await options.storage.put(probe, payload)
    steps.push({ name: 'write', ok: true, detail: '書き込みに成功しました' })
  } catch (cause) {
    steps.push({ name: 'write', ok: false, detail: `書き込めません: ${describe(cause)}` })
    return { ok: false, steps }
  }

  try {
    const read = await options.storage.get(probe)
    if (fromUtf8(read) !== fromUtf8(payload)) {
      steps.push({
        name: 'read',
        ok: false,
        detail: '書いた内容と読み戻した内容が一致しません',
      })
      return { ok: false, steps }
    }
    steps.push({ name: 'read', ok: true, detail: '読み戻しに成功しました' })
  } catch (cause) {
    steps.push({ name: 'read', ok: false, detail: `読み戻せません: ${describe(cause)}` })
    return { ok: false, steps }
  }

  try {
    await options.storage.delete(probe)
    steps.push({ name: 'delete', ok: true, detail: '後片付けに成功しました' })
  } catch (cause) {
    steps.push({ name: 'delete', ok: false, detail: `消せません: ${describe(cause)}` })
    return { ok: false, steps }
  }

  return { ok: true, steps }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/group/connection-check.test.ts && npm run typecheck
```

Expected: 9 tests passed、型チェックはエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/group/connection-check.ts tests/group/connection-check.test.ts
git commit -m "feat(group): check storage read-write-delete before provisioning"
```

---
### Task 4: 開設の一連の流れ

**Files:**
- Create: `src/group/setup.ts`
- Test: `tests/group/setup.test.ts`

**Interfaces:**
- Consumes: Task 2 の `buildRecoveryKit` / `RecoveryKit`、Task 3 の `checkConnection` / `CheckResult`、`provisionGroup` / `writeObjects` / `NewMember` / `INITIAL_GENERATION`、`StorageSettings` / `writeStorageSettings` / `toProviderConfig`、`DEFAULT_GROUP_SETTINGS` / `writeGroupSettings`、`publishGrants`、`S3StorageProvider`、`ConnectionCode` / `encodeConnectionCode`、`parseKeystoreFile` / `unlockKeystore`、`parseKeyringFile` / `unlockKeyring`、`keystorePath` / `keyringPath`、`keyId` / `STAFF_SCOPE`、`Subgroup`、`KdfParams`
- Produces: `class SetupError extends Error`、`interface SetupOptions { groupId: string; groupName: string; adminLoginId: string; adminDisplayName: string; adminPassword: string; adminEmail: string; settings: StorageSettings; subgroups?: Subgroup[]; members?: NewMember[]; kdf?: KdfParams }`、`interface SetupResult { code: ConnectionCode; connectionCode: string; recoveryKit: RecoveryKit; check: CheckResult; grantsIssued: string[] }`、`setUpGroup(options: SetupOptions): Promise<SetupResult>`

開設の全部をここに集める。順序が本質なので、画面ではなくドメインに置く。

```
1. 資格情報からプロバイダを作る
2. 接続確認 → 失敗したら SetupError。ここで止めれば何も書かれていない
3. provisionGroup で鍵・名簿・キーストア一式を作る
4. ストレージへ書き込む
5. staff スコープ鍵で settings/storage.enc と settings/templates.enc を書く
6. 参加者がいれば投函枠を配る
7. 管理者のキーストアを解錠してリカバリキットを作る
```

**接続確認に失敗したら何も書かない。** 途中まで書いたグループが残ると、次の開設で上書きされるまで中途半端な状態がストレージに残る。

**リカバリキットは開設の戻り値に必ず含める。** 「あとで出す」導線にすると出さないまま運用が始まり、ルート鍵を失った時点で詰む(設計書 §4.8)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/group/setup.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SetupError, setUpGroup } from '../../src/group/setup'
import type { SetupOptions } from '../../src/group/setup'
import { parseRecoveryKit } from '../../src/group/recovery-kit'
import { readGroupSettings } from '../../src/group/group-settings'
import { readStorageSettings } from '../../src/group/storage-credentials'
import { decodeConnectionCode } from '../../src/group/connection-code'
import { login } from '../../src/group/session'
import { grantPath } from '../../src/inbox/grants'
import { parseRosterFile, verifyRoster } from '../../src/crypto/roster'
import { rosterPath } from '../../src/storage/paths'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { fromBase64 } from '../../src/crypto/bytes'
import type { Bytes } from '../../src/crypto/bytes'
import type { StorageProvider } from '../../src/storage/provider'

const settings = {
  provider: 's3' as const,
  endpoint: 'https://example.invalid',
  region: 'auto',
  bucket: 'mofune',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
}

function options(storage: StorageProvider, extra: Partial<SetupOptions> = {}): SetupOptions {
  return {
    groupId: 'midori',
    groupName: 'みどり台グループ',
    adminLoginId: 'watanabe',
    adminDisplayName: '渡辺 けい',
    adminPassword: 'admin-pass',
    adminEmail: 'watanabe@example.invalid',
    settings,
    kdf: TEST_KDF,
    storage,
    ...extra,
  } as SetupOptions
}

function failingPut(): StorageProvider {
  const inner = new MemoryStorageProvider()
  return {
    capabilities: inner.capabilities,
    put: () => Promise.reject(new Error('denied')),
    get: (path: string) => inner.get(path),
    delete: (path: string) => inner.delete(path),
    list: (prefix: string, after?: string) => inner.list(prefix, after),
  }
}

describe('setUpGroup', () => {
  it('reports every connection check step', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    expect(result.check.ok).toBe(true)
    expect(result.check.steps).toHaveLength(3)
  })

  it('writes the roster, and it verifies against the connection code', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    const file = parseRosterFile(await storage.get(rosterPath('midori')))
    await expect(
      verifyRoster(file, fromBase64(result.code.adminPublicKey)),
    ).resolves.toBeDefined()
  })

  it('lets the admin log in with the code it produced', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    const session = await login({
      code: decodeConnectionCode(result.connectionCode),
      loginId: 'watanabe',
      password: 'admin-pass',
      storage,
    })
    expect(session.role).toBe('admin')
    expect(session.groupName).toBe('みどり台グループ')
  })

  it('stores the write credentials under the staff scope', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    const session = await login({
      code: decodeConnectionCode(result.connectionCode),
      loginId: 'watanabe',
      password: 'admin-pass',
      storage,
    })
    const stored = await readStorageSettings({
      storage,
      groupId: 'midori',
      keys: session.groupKeys,
    })
    expect(stored.bucket).toBe('mofune')
  })

  it('writes the default group settings', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    const session = await login({
      code: decodeConnectionCode(result.connectionCode),
      loginId: 'watanabe',
      password: 'admin-pass',
      storage,
    })
    const staffKey = session.groupKeys.get('staff:v1') as CryptoKey
    const stored = await readGroupSettings({ storage, groupId: 'midori', staffKey })
    expect(stored.absenceReasons.length).toBeGreaterThan(0)
  })

  it('returns a recovery kit that restores the admin root key', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    const restored = await parseRecoveryKit(result.recoveryKit.code)
    expect(restored.groupId).toBe('midori')
    expect(restored.contents.ecdsa.privateKey.length).toBeGreaterThan(0)
  })

  it('issues upload grants for members', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(
      options(storage, {
        members: [
          {
            loginId: 'sato',
            displayName: '佐藤 さくら',
            role: 'member',
            scopes: [],
            password: 'member-pass',
            email: '',
          },
        ],
      }),
    )
    expect(result.grantsIssued).toHaveLength(1)
    expect((await storage.list('midori/inbox/')).length).toBeGreaterThan(0)
  })

  it('issues no grants when the group has no members yet', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    expect(result.grantsIssued).toEqual([])
  })

  it('does not write anything when the connection check fails', async () => {
    const storage = failingPut()
    await expect(setUpGroup(options(storage))).rejects.toThrow(SetupError)
    expect(await storage.list('midori/')).toHaveLength(0)
  })

  it('says which step of the connection check failed', async () => {
    const storage = failingPut()
    await expect(setUpGroup(options(storage))).rejects.toThrow(/書き込めません/)
  })

  it('produces a connection code that decodes back', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(options(storage))
    const decoded = decodeConnectionCode(result.connectionCode)
    expect(decoded.groupId).toBe('midori')
    expect(decoded.pepper.length).toBeGreaterThan(0)
  })

  it('creates the subgroups it was given', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(
      options(storage, { subgroups: [{ id: 'sg_a', name: 'Aチーム', parent: null }] }),
    )
    const file = parseRosterFile(await storage.get(rosterPath('midori')))
    const roster = await verifyRoster(file, fromBase64(result.code.adminPublicKey))
    expect(roster.subgroups.map((s) => s.id)).toEqual(['sg_a'])
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/group/setup.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/group/setup"`

- [ ] **Step 3: 実装する**

`src/group/setup.ts`:

```ts
import { keyId } from '../crypto/keyring'
import { parseKeyringFile, unlockKeyring } from '../crypto/keyring'
import type { KdfParams } from '../crypto/kdf'
import { parseKeystoreFile, unlockKeystore } from '../crypto/keystore'
import type { Subgroup } from '../crypto/roster'
import { STAFF_SCOPE } from '../crypto/roster'
import { keyringPath, keystorePath } from '../storage/paths'
import type { StorageProvider } from '../storage/provider'
import type { ConnectionCode } from './connection-code'
import { encodeConnectionCode } from './connection-code'
import type { CheckResult } from './connection-check'
import { checkConnection } from './connection-check'
import { DEFAULT_GROUP_SETTINGS, writeGroupSettings } from './group-settings'
import { publishGrants } from '../inbox/grants'
import type { NewMember } from './provision'
import { INITIAL_GENERATION, provisionGroup, writeObjects } from './provision'
import type { RecoveryKit } from './recovery-kit'
import { buildRecoveryKit } from './recovery-kit'
import type { StorageSettings } from './storage-credentials'
import { writeStorageSettings } from './storage-credentials'

export class SetupError extends Error {}

export interface SetupOptions {
  groupId: string
  groupName: string
  adminLoginId: string
  adminDisplayName: string
  adminPassword: string
  adminEmail: string
  settings: StorageSettings
  storage: StorageProvider
  subgroups?: Subgroup[]
  members?: NewMember[]
  kdf?: KdfParams
}

export interface SetupResult {
  code: ConnectionCode
  connectionCode: string
  recoveryKit: RecoveryKit
  check: CheckResult
  grantsIssued: string[]
}

/**
 * 開設の一連の流れ。順序が本質なので画面ではなくここに置く。
 *
 * 接続確認に失敗したら何も書かない。途中まで書いたグループが残ると、
 * 中途半端な状態がストレージに残り続ける。
 */
export async function setUpGroup(options: SetupOptions): Promise<SetupResult> {
  const check = await checkConnection({
    storage: options.storage,
    groupId: options.groupId,
  })
  if (!check.ok) {
    const failed = check.steps.find((step) => !step.ok)
    throw new SetupError(failed?.detail ?? 'ストレージの接続確認に失敗しました')
  }

  const admin: NewMember = {
    loginId: options.adminLoginId,
    displayName: options.adminDisplayName,
    role: 'admin',
    scopes: [],
    password: options.adminPassword,
    email: options.adminEmail,
  }
  const provisioned = await provisionGroup({
    groupId: options.groupId,
    groupName: options.groupName,
    provider: options.settings.provider,
    root: `${options.settings.endpoint}/${options.settings.bucket}`,
    subgroups: options.subgroups ?? [],
    members: [admin, ...(options.members ?? [])],
    ...(options.kdf ? { kdf: options.kdf } : {}),
  })
  await writeObjects(options.storage, provisioned.objects)

  // 管理者のキーストアを解いて staff スコープ鍵とルート鍵を取り出す
  const keystore = await unlockKeystore(
    parseKeystoreFile(
      provisioned.objects.get(
        await keystorePath(options.groupId, options.adminLoginId),
      ) as never,
    ),
    options.adminPassword,
    provisioned.code.pepper,
  )
  const keyring = parseKeyringFile(
    provisioned.objects.get(keyringPath(options.groupId, INITIAL_GENERATION)) as never,
  )
  const keys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)
  const staffKey = keys.get(keyId(STAFF_SCOPE, INITIAL_GENERATION))
  if (!staffKey) {
    throw new SetupError('the staff scope key was not created')
  }

  await writeStorageSettings({
    storage: options.storage,
    groupId: options.groupId,
    settings: options.settings,
    staffKey,
    generation: INITIAL_GENERATION,
  })
  await writeGroupSettings({
    storage: options.storage,
    groupId: options.groupId,
    settings: DEFAULT_GROUP_SETTINGS,
    staffKey,
    generation: INITIAL_GENERATION,
  })

  const roster = { groupId: options.groupId, generation: INITIAL_GENERATION, subgroups: options.subgroups ?? [], members: [] }
  const grantsIssued = await publishGrants({
    storage: options.storage,
    groupId: options.groupId,
    roster: {
      ...roster,
      members: (options.members ?? []).map((member, index) => ({
        userId: `u_pending_${index}`,
        displayName: member.displayName,
        role: member.role,
        scopes: [],
        ecdhPublic: '',
        ecdsaPublic: '',
      })),
    },
    settings: options.settings,
  })

  // リカバリキットは戻り値に必ず含める。あとで出す導線にすると
  // 出さないまま運用が始まり、ルート鍵を失った時点で詰む(設計書 §4.8)。
  const recoveryKit = await buildRecoveryKit({
    groupId: options.groupId,
    groupName: options.groupName,
    contents: keystore,
  })

  return {
    code: provisioned.code,
    connectionCode: encodeConnectionCode(provisioned.code),
    recoveryKit,
    check,
    grantsIssued,
  }
}
```

**`publishGrants` に渡す名簿について。** 上のコードは仮の userId を組み立てているが、これは誤りである。`provisionGroup` が実際に採番した userId と公開鍵を使わなければ、参加者はその grant を復号できない。**実装時は署名済み名簿から実物を読むこと。** `provisioned.objects` の `rosterPath` を `parseRosterFile` → `verifyRoster` して `RosterContents` を得て、それを `publishGrants` に渡す。テスト `issues upload grants for members` は grant が書かれたことしか見ていないので仮実装でも通ってしまう。**通ったからといって仮のままにしないこと。**

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/group/setup.test.ts && npm run typecheck
```

Expected: 13 tests passed、型チェックはエラーなし。

- [ ] **Step 5: 参加者が grant を開けることを確かめる**

上の注意点を落とさないため、次のテストを `tests/group/setup.test.ts` に追記して green にする。

```ts
  it('issues grants the member can actually decrypt', async () => {
    const storage = new MemoryStorageProvider()
    const result = await setUpGroup(
      options(storage, {
        members: [
          {
            loginId: 'sato',
            displayName: '佐藤 さくら',
            role: 'member',
            scopes: [],
            password: 'member-pass',
            email: '',
          },
        ],
      }),
    )
    const { readGrant } = await import('../../src/inbox/grants')
    const session = await login({
      code: decodeConnectionCode(result.connectionCode),
      loginId: 'sato',
      password: 'member-pass',
      storage,
    })
    const grant = await readGrant({
      storage,
      groupId: 'midori',
      userId: session.userId,
      ecdhPrivate: session.ecdhPrivate,
    })
    expect(grant.slots.length).toBeGreaterThan(0)
  })
```

- [ ] **Step 6: コミット**

```bash
git add src/group/setup.ts tests/group/setup.test.ts
git commit -m "feat(group): provision a group end to end with a recovery kit"
```

---

### Task 5: 開設ウィザード画面 (design 10)

**Files:**
- Create: `src/ui/ProvisionWizardView.vue`
- Modify: `src/App.vue`
- Test: `tests/ui/ProvisionWizardView.test.ts`

**Interfaces:**
- Consumes: Task 4 の `setUpGroup` / `SetupResult`、`S3StorageProvider` / `toProviderConfig`、`StorageSettings`
- Produces: `ProvisionWizardView.vue`(props なし。emit: `done` に `connectionCode: string`、`cancel`)

design 10 の画面。4ステップで進む。

1. グループの情報(名前・管理者のログインID・表示名・パスワード・メール)
2. データの置き場(S3互換のエンドポイント・バケット・鍵)。**inbox 対応の有無を選ぶ前に示す**(design 10)
3. 接続の確認 — 各ステップの成否を出す
4. リカバリキット — 印刷を促し、**保管を確認するまで完了させない**

**リカバリキットのチェックを飛ばせないようにする。** ここを任意にすると誰も保管せず、ルート鍵を失った時点でグループが詰む。

**接続コードとリカバリキットは、この画面を離れると二度と出せない。** リカバリキットは鍵そのもので、接続コードもストレージからは復元できない(pepper が含まれるため)。画面にその旨を明記する。

- [ ] **Step 1: 失敗するテストを書く**

`tests/ui/ProvisionWizardView.test.ts`:

```ts
// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import ProvisionWizardView from '../../src/ui/ProvisionWizardView.vue'

let mounted: VueWrapper[] = []

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted = []
})

function mountWizard() {
  const wrapper = mount(ProvisionWizardView)
  mounted.push(wrapper)
  return wrapper
}

async function fillGroupStep(wrapper: VueWrapper) {
  await wrapper.find('[data-test="group-name"]').setValue('みどり台グループ')
  await wrapper.find('[data-test="admin-login-id"]').setValue('watanabe')
  await wrapper.find('[data-test="admin-display-name"]').setValue('渡辺 けい')
  await wrapper.find('[data-test="admin-password"]').setValue('admin-pass-1234')
  await wrapper.find('[data-test="admin-email"]').setValue('watanabe@example.com')
  await wrapper.find('[data-test="next"]').trigger('click')
}

async function fillStorageStep(wrapper: VueWrapper) {
  await wrapper.find('[data-test="endpoint"]').setValue('https://example.invalid')
  await wrapper.find('[data-test="bucket"]').setValue('mofune')
  await wrapper.find('[data-test="access-key-id"]').setValue('AKID')
  await wrapper.find('[data-test="secret-access-key"]').setValue('SECRET')
  await wrapper.find('[data-test="next"]').trigger('click')
}

describe('ProvisionWizardView', () => {
  it('starts on the group information step', () => {
    const wrapper = mountWizard()
    expect(wrapper.find('[data-test="step"]').text()).toContain('1')
    expect(wrapper.find('[data-test="group-name"]').exists()).toBe(true)
  })

  it('refuses to move on without the group information', async () => {
    const wrapper = mountWizard()
    await wrapper.find('[data-test="next"]').trigger('click')
    expect(wrapper.find('[data-test="error"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="group-name"]').exists()).toBe(true)
  })

  it('moves to the storage step once the information is filled in', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    expect(wrapper.find('[data-test="endpoint"]').exists()).toBe(true)
  })

  it('says which providers support the member uplink', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    expect(wrapper.text()).toContain('欠席')
  })

  it('runs the connection check on the third step', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="check-result"]').exists()) throw new Error('not checked')
    }, { timeout: 4000, interval: 20 })
    expect(wrapper.findAll('[data-test="check-step"]').length).toBeGreaterThan(0)
  })

  it('shows the recovery kit only after provisioning succeeds', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="recovery-code"]').exists()) throw new Error('not yet')
    }, { timeout: 8000, interval: 20 })
    expect(wrapper.find('[data-test="recovery-code"]').text().length).toBeGreaterThan(0)
  })

  it('shows the connection code to hand out', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="connection-code"]').exists()) throw new Error('not yet')
    }, { timeout: 8000, interval: 20 })
    expect(wrapper.find('[data-test="connection-code"]').text().length).toBeGreaterThan(0)
  })

  it('will not finish until the admin confirms the kit is stored', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="finish"]').exists()) throw new Error('not yet')
    }, { timeout: 8000, interval: 20 })
    await wrapper.find('[data-test="finish"]').trigger('click')
    expect(wrapper.emitted('done')).toBeFalsy()

    await wrapper.find('[data-test="kit-stored"]').setValue(true)
    await wrapper.find('[data-test="finish"]').trigger('click')
    expect(wrapper.emitted('done')).toBeTruthy()
  })

  it('warns that the kit and the code cannot be shown again', async () => {
    const wrapper = mountWizard()
    await fillGroupStep(wrapper)
    await fillStorageStep(wrapper)
    await vi.waitFor(() => {
      if (!wrapper.find('[data-test="recovery-code"]').exists()) throw new Error('not yet')
    }, { timeout: 8000, interval: 20 })
    expect(wrapper.text()).toContain('二度と')
  })

  it('emits cancel from the first step', async () => {
    const wrapper = mountWizard()
    await wrapper.find('[data-test="cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toBeTruthy()
  })
})
```

**テストが実バケットを叩かないようにする。** `S3StorageProvider` は `fetch` を使うので、`beforeEach` で `vi.stubGlobal('fetch', …)` してインメモリに向けるか、コンポーネントがプロバイダを差し替えられる形にする。実装時にどちらかを選び、**外部へ通信しないことを確認すること**(テストがネットワークに出ると CI が不安定になる)。前者を選ぶ場合は `tests/ui/LoginView.test.ts` の `routeFetchTo` と同じ手法が使える。

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/ui/ProvisionWizardView.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/ui/ProvisionWizardView.vue"`

- [ ] **Step 3: 実装する**

`src/ui/ProvisionWizardView.vue` を作る。要点は次のとおり。

- `step` を `1 | 2 | 3` で持つ。1 が情報、2 がストレージ、3 が結果
- 各入力に `data-test` を付ける(テストのセレクタと一致させる)
- step 2 の `next` で `setUpGroup` を呼び、`check` と `SetupResult` を保存して step 3 へ
- step 3 では `check.steps` を並べ、成功していれば接続コードとリカバリキットを出す
- `kitStored` のチェックが真でなければ `finish` で `done` を出さない
- ストレージ種別の選択肢は設計書 §7.2 の表をそのまま出し、**inbox 非対応(Google Drive / Dropbox)は「欠席連絡が使えない」と選択前に明示する**
- 生成したプロバイダは `new S3StorageProvider(toProviderConfig(settings))`

`src/App.vue` の未ログイン時に導線を足す。

```ts
const provisioning = ref(false)
```

```vue
    <ProvisionWizardView
      v-if="!session && provisioning"
      @done="provisioning = false"
      @cancel="provisioning = false"
    />
    <template v-else-if="!session || !storage">
      <LoginView @login="onLogin" />
      <button data-test="provision" @click="provisioning = true">グループを作る</button>
    </template>
```

既存の `v-if="!session || !storage"` を上の形に置き換えること。`tests/ui/LoginView.test.ts` は `LoginView` を直接マウントしているので影響しない。

- [ ] **Step 4: 全体の検証**

```bash
npm run test:run && npm run typecheck && npm run build
```

Expected: すべて成功。

- [ ] **Step 5: コミット**

```bash
git add src/ui/ProvisionWizardView.vue src/App.vue tests/ui/ProvisionWizardView.test.ts
git commit -m "feat(ui): add the provisioning wizard with a mandatory recovery kit"
```

---

## Phase 2f 完了条件

- `npm run test:run` が全て green。**3回連続で通ること**
- `npm run typecheck` がエラーなし
- `npm run build` が成功する
- 接続確認に失敗したときストレージに何も書かれない(Task 4)
- 開設した直後の接続コードで管理者がログインできる(Task 4)
- **参加者が自分の grant を復号できる**(Task 4 Step 5。仮の userId で済ませていないことの確認)
- リカバリキットの保管を確認するまでウィザードが完了しない(Task 5)
- UI テストが外部へ通信しない(Task 5)

## 次フェーズへの引き継ぎ

- **実バケットでの疎通確認。** Phase 2f が終われば、S3互換サービスを1つ用意して実際に開設できる。検証課題 §16-6(カード登録の要否)と §16-7(CORS 設定)はここで確かめる
- **`DEFAULT_MAX_URL_LENGTH` の実機検証**(§16-1)。実機のメーラーで mailto の上限を測る
- TO のグループ共用アドレスをウィザードで受け取り、`GroupSettings` に持たせる
- リカバリキットからの復元フロー(パスワードを失った管理者が鍵を戻す画面)。読み取りは Task 2 で用意した
- メンバー招待・追加の画面(design 09)。今は開設時に渡した人だけ
- グループ設定の編集画面(テンプレート・定型理由・通知停止)
- Web Push と関数層 → Phase 3
- フォーム機能 → Phase 3
