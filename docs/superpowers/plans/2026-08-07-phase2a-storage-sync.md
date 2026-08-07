# Phase 2a: ストレージと同期 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** グループのストレージ(S3互換)へ実際に読み書きでき、イベントログの差分同期でローカルDBを最新化できる状態にする。

**Architecture:** ブラウザから直接 S3 互換 API を叩く。AWS SDK は 200kB 超で PWA には重すぎるため、SigV4 署名は Web Crypto の HMAC で自前実装し、正しさは AWS 公式署名ライブラリを照合オラクルにしたテストで担保する(devDependency のみ、配布物には入らない)。書き込み資格情報は staff スコープで暗号化して `settings/storage.enc` に置く(設計書 §7.4)。同期は追記専用のイベントログをカーソル以降だけ範囲取得する。

**Tech Stack:** TypeScript / Vite / Vitest / Dexie.js / Web Crypto API

正は [要件書](../../Mofune%20-%20要件書.md) / [設計書](../../Mofune%20-%20設計書.md)。Phase 1 の成果物(`src/crypto/*`, `src/group/*`, `src/storage/{provider,paths,memory,http}.ts`, `src/db/groups.ts`)の上に載る。

## Global Constraints

Phase 1 の Global Constraints をすべて引き継ぐ。特に:

- 暗号プリミティブは Web Crypto API のみ。例外は Argon2id (hash-wasm) のみ
- **バイト列の型は `src/crypto/bytes.ts` の `Bytes`(= `Uint8Array<ArrayBuffer>`)を使う。** 型注釈上の `Uint8Array` はすべて `Bytes` と読み替える(`new Uint8Array(...)` という生成式はそのまま)。テストの `as Uint8Array` も `as Bytes` に読み替える
- 秘密鍵・パスワード・ストレージ資格情報を IndexedDB / localStorage に保存してはならない。セッションはメモリ上のみ
- ロールは `admin` / `staff` / `member`。用途固有語(園・クラス・先生・保護者)をコードにもUIにも持ち込まない
- スコープ鍵はすべて独立に生成する。サブグループの親子関係から子の鍵を導出してはならない
- 暗号化オブジェクトは必ずマルチレシピエントエンベロープ(`sealEnvelopeFor`)を通す
- `tsconfig.json` は `strict: true` と `verbatimModuleSyntax: true`。型のみの import は `import type`
- テストは `tests/**/*.test.ts`。Vitest のグローバル API は使わず `import { describe, it, expect } from 'vitest'` を明示する
- 本番の KDF パラメータ (`PRODUCTION_KDF`) をテストで使わない。テストは必ず `TEST_KDF`
- コミットは Conventional Commits 形式。`Co-Authored-By` 行は付けない
- **バージョン番号を手で書かない。** 新規依存は `npm install` で解決させ、`package.json` に記録された値をそのまま使う
- 照合オラクル用のパッケージは必ず `devDependencies` に入れる。`src/` から import してはならない(配布物が肥大するため)

## File Structure

```
src/storage/provider.ts             list に after を追加(既存を変更)          Task 1
src/storage/memory.ts               同上                                          Task 1
src/storage/http.ts                 同上                                          Task 1
src/storage/s3/sigv4.ts             SigV4 署名の中核(正規化・署名鍵・署名)      Task 2
src/storage/s3/presign.ts           presigned URL(クエリ署名)                   Task 3
src/storage/s3/list.ts              ListObjectsV2 の XML 解析                     Task 4
src/storage/s3.ts                   S3StorageProvider                             Task 5
src/group/storage-credentials.ts    settings/storage.enc の読み書き               Task 6
src/sync/events.ts                  イベント型・ID生成・封緘/開封                 Task 7
src/db/group-db.ts                  グループ単位の Dexie スキーマ                 Task 8
src/sync/sync.ts                    カーソル差分同期                              Task 9
src/sync/outbox.ts                  保留キューと再送                              Task 10
```

各タスクは独立にテストでき、単体でレビューを通せる粒度で切ってある。

---

### Task 1: 一覧にカーソルを追加する

**Files:**
- Modify: `src/storage/provider.ts`(`StorageProvider.list` のシグネチャ)
- Modify: `src/storage/memory.ts`(`list` の実装)
- Modify: `src/storage/http.ts`(`list` のシグネチャ追従)
- Test: `tests/storage/memory.test.ts`(既存に追記)

**Interfaces:**
- Consumes: なし
- Produces: `StorageProvider.list(prefix: string, after?: string): Promise<StorageEntry[]>`

Phase 1 の `list` は `prefix` だけを取る。イベントの差分同期は「カーソルより後だけを取る」ことに依存する(設計書 §6.1)ため、まず既存インターフェースを拡張する。以降のタスクはすべてこの形を前提にする。

`after` の意味は「このパスより後(排他)」。パスの辞書順で比較する。イベントのファイル名は時系列にソートできる形式なので、辞書順比較がそのまま時系列比較になる。

現状の定義は次のとおり(実装前に `src/storage/provider.ts` を開いて確認済み)。

```ts
export interface StorageEntry {
  path: string
  size: number
}

export interface StorageCapabilities {
  read: boolean
  write: boolean
  list: boolean
  inbox: boolean
}
```

- [ ] **Step 1: 失敗するテストを書く**

`tests/storage/memory.test.ts` の `describe` ブロックの中に、次の4つを**追記**する(既存のテストは消さない)。

```ts
  it('returns every entry under the prefix when no cursor is given', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('midori/events/a.enc', utf8('1'))
    await storage.put('midori/events/b.enc', utf8('2'))
    expect((await storage.list('midori/events/')).map((entry) => entry.path)).toEqual([
      'midori/events/a.enc',
      'midori/events/b.enc',
    ])
  })

  it('returns only entries after the cursor', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('midori/events/a.enc', utf8('1'))
    await storage.put('midori/events/b.enc', utf8('2'))
    await storage.put('midori/events/c.enc', utf8('3'))
    expect(
      (await storage.list('midori/events/', 'midori/events/a.enc')).map((entry) => entry.path),
    ).toEqual(['midori/events/b.enc', 'midori/events/c.enc'])
  })

  it('excludes the cursor entry itself', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('midori/events/a.enc', utf8('1'))
    expect(await storage.list('midori/events/', 'midori/events/a.enc')).toEqual([])
  })

  it('ignores a cursor that is outside the prefix', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('midori/events/a.enc', utf8('1'))
    await storage.put('midori/messages/m.enc', utf8('2'))
    expect(
      (await storage.list('midori/events/', 'midori/aaa')).map((entry) => entry.path),
    ).toEqual(['midori/events/a.enc'])
  })
```

`utf8` が既存のテストで import されていない場合は `import { utf8 } from '../../src/crypto/bytes'` を足す。

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/storage/memory.test.ts
```

Expected: FAIL — `after` が無視されるため「returns only entries after the cursor」と「excludes the cursor entry itself」が落ちる。`list` の第2引数は TypeScript 上もエラーになる。

- [ ] **Step 3: インターフェースを拡張する**

`src/storage/provider.ts` の `list` を差し替える:

```ts
  /**
   * prefix 配下を辞書順で返す。after を渡すと、そのパスより後(排他)だけを返す。
   * イベントログの差分同期がこの範囲取得に依存する。
   */
  list(prefix: string, after?: string): Promise<StorageEntry[]>
```

`src/storage/memory.ts` の `list` を差し替える:

```ts
  async list(prefix: string, after?: string): Promise<StorageEntry[]> {
    return [...this.objects.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .filter(([path]) => after === undefined || path > after)
      .map(([path, data]) => ({ path, size: data.length }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }
```

`src/storage/http.ts` の `list` を差し替える(公開読み取り専用なので挙動は変わらない):

```ts
  async list(_prefix: string, _after?: string): Promise<StorageEntry[]> {
    throw new UnsupportedOperationError('HttpStorageProvider cannot list objects')
  }
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/storage/memory.test.ts
npm run typecheck
```

Expected: memory のテストが全て green、型チェックもエラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/storage/provider.ts src/storage/memory.ts src/storage/http.ts tests/storage/memory.test.ts
git commit -m "feat(storage): add a cursor argument to list for incremental sync"
```

---

### Task 2: SigV4 署名の中核

**Files:**
- Modify: `package.json`(devDependencies に照合オラクルを追加)
- Create: `src/storage/s3/sigv4.ts`
- Test: `tests/storage/s3/sigv4.test.ts`

**Interfaces:**
- Consumes: Task 2(Phase 1)の `Bytes` / `toHex` / `utf8`、Task 3(Phase 1)の `sha256`
- Produces: 定数 `ALGORITHM = 'AWS4-HMAC-SHA256'` / `SERVICE = 's3'` / `UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'`、`interface S3Credentials { accessKeyId: string; secretAccessKey: string }`、`interface CanonicalRequestInput { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; payloadHash: string }`、`uriEncode(text: string, encodeSlash: boolean): string` / `canonicalQueryString(query: Record<string, string>): string` / `canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string }` / `canonicalRequest(input: CanonicalRequestInput): string` / `amzTimestamps(now: Date): { amzDate: string; dateStamp: string }` / `credentialScope(dateStamp: string, region: string): string` / `signingKey(secretAccessKey: string, dateStamp: string, region: string): Promise<Bytes>` / `stringToSign(amzDate: string, scope: string, request: string): Promise<string>` / `calculateSignature(key: Bytes, toSign: string): Promise<string>` / `signRequestHeaders(options: SignRequestOptions): Promise<Record<string, string>>`、`interface SignRequestOptions { credentials: S3Credentials; region: string; method: string; url: URL; headers?: Record<string, string>; payload?: Bytes; now?: Date }`

**署名の仕様**(AWS 公式ドキュメントで確認済み。[Create a signed AWS API request](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html)):

```
署名鍵の導出:
  DateKey              = HMAC-SHA256("AWS4" + SecretAccessKey, YYYYMMDD)
  DateRegionKey        = HMAC-SHA256(DateKey, region)
  DateRegionServiceKey = HMAC-SHA256(DateRegionKey, "s3")
  SigningKey           = HMAC-SHA256(DateRegionServiceKey, "aws4_request")

正規化リクエスト(改行区切り、末尾に改行を付けない):
  HTTPMethod \n CanonicalURI \n CanonicalQueryString \n CanonicalHeaders \n SignedHeaders \n HashedPayload

署名文字列(改行区切り、末尾に改行を付けない):
  "AWS4-HMAC-SHA256" \n RequestDateTime \n CredentialScope \n Hex(SHA256(CanonicalRequest))
  CredentialScope = YYYYMMDD/region/s3/aws4_request  (region と service は小文字)

署名 = Hex(HMAC-SHA256(SigningKey, 署名文字列))  ← 小文字16進
```

**テスト戦略について(重要)**: AWS 公式ドキュメントにはアルゴリズムの定義はあるが、S3 向けの「入力一式と期待署名 hex」の完全な組は本計画作成時に確認できなかった。**期待値の hex を記憶で書き下してはならない。** 代わりに AWS 公式の署名実装を照合オラクルとして使い、自前実装がバイト単位で一致することを検証する。定数を1つも捏造せずに正しさを担保できる。

- [ ] **Step 1: 照合オラクルを devDependency として導入する**

```bash
npm install -D @smithy/signature-v4 @smithy/protocol-http @aws-crypto/sha256-js
```

エクスポート名は実機で確認済み: `@smithy/signature-v4` が `SignatureV4`、`@smithy/protocol-http` が `HttpRequest`、`@aws-crypto/sha256-js` が `Sha256`。

- [ ] **Step 2: 失敗するテストを書く**

`tests/storage/s3/sigv4.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SignatureV4 } from '@smithy/signature-v4'
import { HttpRequest } from '@smithy/protocol-http'
import { Sha256 } from '@aws-crypto/sha256-js'
import {
  ALGORITHM,
  amzTimestamps,
  canonicalHeaders,
  canonicalQueryString,
  canonicalRequest,
  credentialScope,
  signRequestHeaders,
  uriEncode,
} from '../../../src/storage/s3/sigv4'

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}
const region = 'us-east-1'
const now = new Date('2026-08-07T09:12:34.000Z')

/**
 * AWS 公式実装で「まったく同じリクエスト」に署名し、Authorization ヘッダを返す。
 * 自前実装が生成したヘッダをそのまま渡すのが要点。片方だけ x-amz-content-sha256 を
 * 持つ状態で比較すると、署名対象が違うので当然一致しない。
 * ここで渡すのは署名の入力であり、比較するのは出力(署名)なので、
 * オラクルとしての独立性は保たれる。
 */
async function oracleAuthorization(
  method: string,
  url: URL,
  produced: Record<string, string>,
): Promise<string> {
  const headers: Record<string, string> = { ...produced }
  delete headers['Authorization']
  const signer = new SignatureV4({
    service: 's3',
    region,
    credentials,
    sha256: Sha256,
    uriEscapePath: false,
    applyChecksum: false,
  })
  const query: Record<string, string> = {}
  url.searchParams.forEach((value, key) => {
    query[key] = value
  })
  const signed = await signer.sign(
    new HttpRequest({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query,
      headers: { host: url.host, ...headers },
    }),
    { signingDate: now },
  )
  return signed.headers['authorization'] as string
}

describe('uriEncode', () => {
  it('leaves unreserved characters alone', () => {
    expect(uriEncode('abcXYZ019-._~', true)).toBe('abcXYZ019-._~')
  })

  it('percent-encodes spaces as %20 rather than +', () => {
    expect(uriEncode('a b', true)).toBe('a%20b')
  })

  it('encodes slashes only when asked', () => {
    expect(uriEncode('a/b', true)).toBe('a%2Fb')
    expect(uriEncode('a/b', false)).toBe('a/b')
  })

  it('uses uppercase hex', () => {
    expect(uriEncode('~!', true)).toBe('~%21')
  })

  it('encodes multibyte characters as their UTF-8 bytes', () => {
    expect(uriEncode('あ', true)).toBe('%E3%81%82')
  })
})

describe('canonicalQueryString', () => {
  it('sorts parameters by name', () => {
    expect(canonicalQueryString({ b: '2', a: '1' })).toBe('a=1&b=2')
  })

  it('encodes both names and values including slashes', () => {
    expect(canonicalQueryString({ 'X-Amz-Credential': 'AK/20260807' })).toBe(
      'X-Amz-Credential=AK%2F20260807',
    )
  })

  it('returns an empty string for no parameters', () => {
    expect(canonicalQueryString({})).toBe('')
  })
})

describe('canonicalHeaders', () => {
  it('lowercases names, sorts them and terminates each line with a newline', () => {
    const result = canonicalHeaders({ 'X-Amz-Date': '20260807T091234Z', Host: 'example.com' })
    expect(result.canonical).toBe('host:example.com\nx-amz-date:20260807T091234Z\n')
    expect(result.signed).toBe('host;x-amz-date')
  })

  it('trims and collapses whitespace in values', () => {
    expect(canonicalHeaders({ a: '  x   y  ' }).canonical).toBe('a:x y\n')
  })
})

describe('canonicalRequest', () => {
  it('joins the six elements with newlines and does not add a trailing newline', () => {
    const text = canonicalRequest({
      method: 'get',
      path: '/bucket/midori/manifest.json',
      query: {},
      headers: { host: 'example.com' },
      payloadHash: 'HASH',
    })
    expect(text).toBe(
      ['GET', '/bucket/midori/manifest.json', '', 'host:example.com\n', 'host', 'HASH'].join('\n'),
    )
    expect(text.endsWith('\n')).toBe(false)
  })
})

describe('amzTimestamps', () => {
  it('formats the ISO 8601 basic timestamp and the date stamp', () => {
    expect(amzTimestamps(now)).toEqual({ amzDate: '20260807T091234Z', dateStamp: '20260807' })
  })
})

describe('credentialScope', () => {
  it('joins date, region, service and the termination string', () => {
    expect(credentialScope('20260807', 'us-east-1')).toBe('20260807/us-east-1/s3/aws4_request')
  })
})

describe('signRequestHeaders (checked against the AWS reference implementation)', () => {
  it('matches the oracle for a simple GET', async () => {
    const url = new URL('https://example.invalid/bucket/midori/manifest.json')
    const headers = await signRequestHeaders({ credentials, region, method: 'GET', url, now })
    expect(headers['Authorization']).toBe(await oracleAuthorization('GET', url, headers))
  })

  it('matches the oracle for a PUT with a body', async () => {
    const url = new URL('https://example.invalid/bucket/midori/events/1-a.enc')
    const payload = new Uint8Array([1, 2, 3, 4])
    const headers = await signRequestHeaders({
      credentials,
      region,
      method: 'PUT',
      url,
      payload,
      now,
    })
    expect(headers['Authorization']).toBe(await oracleAuthorization('PUT', url, headers))
  })

  it('matches the oracle for a request with query parameters', async () => {
    const url = new URL(
      'https://example.invalid/bucket?list-type=2&prefix=midori%2Fevents%2F&max-keys=1000',
    )
    const headers = await signRequestHeaders({ credentials, region, method: 'GET', url, now })
    expect(headers['Authorization']).toBe(await oracleAuthorization('GET', url, headers))
  })

  it('announces the algorithm and the credential scope in the header', async () => {
    const url = new URL('https://example.invalid/bucket/midori/manifest.json')
    const headers = await signRequestHeaders({ credentials, region, method: 'GET', url, now })
    expect(headers['Authorization']).toContain(ALGORITHM)
    expect(headers['Authorization']).toContain(
      `Credential=${credentials.accessKeyId}/20260807/us-east-1/s3/aws4_request`,
    )
  })

  it('sends the payload hash of an empty body when there is no payload', async () => {
    const url = new URL('https://example.invalid/bucket/midori/manifest.json')
    const headers = await signRequestHeaders({ credentials, region, method: 'GET', url, now })
    // SHA-256 of the empty string, computed rather than hard-coded
    const empty = await crypto.subtle.digest('SHA-256', new Uint8Array(0))
    const hex = [...new Uint8Array(empty)].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(headers['x-amz-content-sha256']).toBe(hex)
  })
})
```

- [ ] **Step 3: テストを実行して失敗を確認する**

```bash
npx vitest run tests/storage/s3/sigv4.test.ts
```

Expected: FAIL — `Failed to resolve import "../../../src/storage/s3/sigv4"`

- [ ] **Step 4: 実装する**

`src/storage/s3/sigv4.ts`:

```ts
import type { Bytes } from '../../crypto/bytes'
import { toHex, utf8 } from '../../crypto/bytes'
import { sha256 } from '../../crypto/symmetric'

export const ALGORITHM = 'AWS4-HMAC-SHA256'
export const SERVICE = 's3'
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
}

export interface CanonicalRequestInput {
  method: string
  /** 生のパス。この関数がエンコードするので、呼び出し側でエンコードしない。 */
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  payloadHash: string
}

export interface SignRequestOptions {
  credentials: S3Credentials
  region: string
  method: string
  url: URL
  headers?: Record<string, string>
  payload?: Bytes
  now?: Date
}

/**
 * RFC 3986 の unreserved 文字以外を %XX にする。encodeURIComponent は
 * "!" "'" "(" ")" "*" を通してしまい AWS の規則と一致しないため自前で実装する。
 */
export function uriEncode(text: string, encodeSlash: boolean): string {
  let out = ''
  for (const ch of text) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch
      continue
    }
    if (ch === '/' && !encodeSlash) {
      out += ch
      continue
    }
    for (const byte of utf8(ch)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

export function canonicalQueryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name, true)}=${uriEncode(query[name] as string, true)}`)
    .join('&')
}

export function canonicalHeaders(headers: Record<string, string>): {
  canonical: string
  signed: string
} {
  const lower: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    lower[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ')
  }
  const names = Object.keys(lower).sort()
  return {
    canonical: names.map((name) => `${name}:${lower[name] as string}\n`).join(''),
    signed: names.join(';'),
  }
}

export function canonicalRequest(input: CanonicalRequestInput): string {
  const headers = canonicalHeaders(input.headers)
  return [
    input.method.toUpperCase(),
    uriEncode(input.path, false),
    canonicalQueryString(input.query),
    headers.canonical,
    headers.signed,
    input.payloadHash,
  ].join('\n')
}

/** ISO 8601 基本形式 (20260807T091234Z) と日付だけの形式 (20260807) を返す。 */
export function amzTimestamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

export function credentialScope(dateStamp: string, region: string): string {
  return `${dateStamp}/${region}/${SERVICE}/aws4_request`
}

async function hmac(key: Bytes, data: string): Promise<Bytes> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, utf8(data)))
}

export async function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
): Promise<Bytes> {
  const dateKey = await hmac(utf8(`AWS4${secretAccessKey}`), dateStamp)
  const regionKey = await hmac(dateKey, region)
  const serviceKey = await hmac(regionKey, SERVICE)
  return hmac(serviceKey, 'aws4_request')
}

export async function stringToSign(
  amzDate: string,
  scope: string,
  request: string,
): Promise<string> {
  return [ALGORITHM, amzDate, scope, toHex(await sha256(utf8(request)))].join('\n')
}

export async function calculateSignature(key: Bytes, toSign: string): Promise<string> {
  return toHex(await hmac(key, toSign))
}

/** Authorization ヘッダ方式で署名し、リクエストに付けるヘッダ一式を返す。 */
export async function signRequestHeaders(
  options: SignRequestOptions,
): Promise<Record<string, string>> {
  const { amzDate, dateStamp } = amzTimestamps(options.now ?? new Date())
  const scope = credentialScope(dateStamp, options.region)
  const payloadHash = toHex(await sha256(options.payload ?? new Uint8Array(0)))

  const headers: Record<string, string> = {
    ...options.headers,
    host: options.url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }

  const query: Record<string, string> = {}
  options.url.searchParams.forEach((value, name) => {
    query[name] = value
  })

  const request = canonicalRequest({
    method: options.method,
    path: options.url.pathname,
    query,
    headers,
    payloadHash,
  })
  const key = await signingKey(options.credentials.secretAccessKey, dateStamp, options.region)
  const signature = await calculateSignature(key, await stringToSign(amzDate, scope, request))
  const signedHeaders = canonicalHeaders(headers).signed

  return {
    ...headers,
    Authorization:
      `${ALGORITHM} Credential=${options.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
```

- [ ] **Step 5: テストを実行して成功を確認する**

```bash
npx vitest run tests/storage/s3/sigv4.test.ts
```

Expected: 18 tests passed

オラクルと一致しない場合、原因はほぼ次のいずれか。実装側を直すこと(オラクルに合わせて期待値を緩めない)。

1. `uriEscapePath` の扱い — S3 はパスを二重エンコードしない。オラクル生成側で `uriEscapePath: false` を指定しているのはこのため
2. ヘッダ名の大小 — 正規化時に小文字化しているか
3. 空クエリのとき `CanonicalQueryString` が空文字列になっているか(`undefined` を join していないか)
4. `CanonicalHeaders` の各行末の改行(最後の行にも必要)

- [ ] **Step 6: 型チェックとコミット**

```bash
npm run typecheck
git add package.json package-lock.json src/storage/s3/sigv4.ts tests/storage/s3/sigv4.test.ts
git commit -m "feat(storage): add SigV4 request signing for S3-compatible endpoints"
```

---

### Task 3: presigned URL

**Files:**
- Create: `src/storage/s3/presign.ts`
- Test: `tests/storage/s3/presign.test.ts`

**Interfaces:**
- Consumes: Task 2 の `ALGORITHM` / `UNSIGNED_PAYLOAD` / `S3Credentials` / `amzTimestamps` / `canonicalQueryString` / `canonicalRequest` / `credentialScope` / `signingKey` / `stringToSign` / `calculateSignature`
- Produces: `interface PresignOptions { credentials: S3Credentials; region: string; method: 'GET' | 'PUT'; endpoint: string; path: string; expiresIn: number; now?: Date }`、`presignUrl(options: PresignOptions): Promise<string>`

参加者はストレージの資格情報を持たないため、上り(inbox への投函)は担当者が発行した期限付き URL に対する素の `PUT` で行う(設計書 §8)。クエリ署名方式では本文のハッシュを署名対象にできないので `UNSIGNED-PAYLOAD` を使い、署名対象ヘッダは `host` のみに絞る。

- [ ] **Step 1: 失敗するテストを書く**

`tests/storage/s3/presign.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { presignUrl } from '../../../src/storage/s3/presign'

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}
const base = {
  credentials,
  region: 'us-east-1',
  endpoint: 'https://example.invalid',
  expiresIn: 3600,
  now: new Date('2026-08-07T09:12:34.000Z'),
}

describe('presignUrl', () => {
  it('keeps the endpoint origin and the object path', async () => {
    const url = new URL(await presignUrl({ ...base, method: 'PUT', path: '/bucket/inbox/u_a/1' }))
    expect(url.origin).toBe('https://example.invalid')
    expect(url.pathname).toBe('/bucket/inbox/u_a/1')
  })

  it('carries every required query parameter', async () => {
    const url = new URL(await presignUrl({ ...base, method: 'PUT', path: '/bucket/o' }))
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20260807/us-east-1/s3/aws4_request',
    )
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260807T091234Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces a different signature for GET and PUT', async () => {
    const get = new URL(await presignUrl({ ...base, method: 'GET', path: '/bucket/o' }))
    const put = new URL(await presignUrl({ ...base, method: 'PUT', path: '/bucket/o' }))
    expect(get.searchParams.get('X-Amz-Signature')).not.toBe(
      put.searchParams.get('X-Amz-Signature'),
    )
  })

  it('produces a different signature for a different object path', async () => {
    const a = new URL(await presignUrl({ ...base, method: 'PUT', path: '/bucket/inbox/u_a/1' }))
    const b = new URL(await presignUrl({ ...base, method: 'PUT', path: '/bucket/inbox/u_b/1' }))
    expect(a.searchParams.get('X-Amz-Signature')).not.toBe(b.searchParams.get('X-Amz-Signature'))
  })

  it('produces a different signature for a different expiry', async () => {
    const short = new URL(await presignUrl({ ...base, method: 'PUT', path: '/bucket/o' }))
    const long = new URL(
      await presignUrl({ ...base, method: 'PUT', path: '/bucket/o', expiresIn: 7200 }),
    )
    expect(short.searchParams.get('X-Amz-Signature')).not.toBe(
      long.searchParams.get('X-Amz-Signature'),
    )
  })

  it('is deterministic for the same inputs', async () => {
    const a = await presignUrl({ ...base, method: 'PUT', path: '/bucket/o' })
    const b = await presignUrl({ ...base, method: 'PUT', path: '/bucket/o' })
    expect(a).toBe(b)
  })

  it('percent-encodes the credential slashes in the query string', async () => {
    const raw = await presignUrl({ ...base, method: 'PUT', path: '/bucket/o' })
    expect(raw).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260807%2F')
  })

  it('rejects an expiry outside the range S3 accepts', async () => {
    await expect(
      presignUrl({ ...base, method: 'PUT', path: '/bucket/o', expiresIn: 0 }),
    ).rejects.toThrow(/expiresIn/)
    await expect(
      presignUrl({ ...base, method: 'PUT', path: '/bucket/o', expiresIn: 604801 }),
    ).rejects.toThrow(/expiresIn/)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/storage/s3/presign.test.ts
```

Expected: FAIL — `Failed to resolve import "../../../src/storage/s3/presign"`

- [ ] **Step 3: 実装する**

`src/storage/s3/presign.ts`:

```ts
import type { S3Credentials } from './sigv4'
import {
  ALGORITHM,
  UNSIGNED_PAYLOAD,
  amzTimestamps,
  calculateSignature,
  canonicalQueryString,
  canonicalRequest,
  credentialScope,
  signingKey,
  stringToSign,
} from './sigv4'

/** S3 が受け付ける presigned URL の有効期限の上限 (7 日)。 */
export const MAX_EXPIRES_IN = 604800

export interface PresignOptions {
  credentials: S3Credentials
  region: string
  method: 'GET' | 'PUT'
  /** スキームとホストまで。末尾のスラッシュは付けない。 */
  endpoint: string
  /** '/bucket/key' 形式のパス。 */
  path: string
  /** 秒。1 以上 MAX_EXPIRES_IN 以下。 */
  expiresIn: number
  now?: Date
}

export async function presignUrl(options: PresignOptions): Promise<string> {
  if (options.expiresIn < 1 || options.expiresIn > MAX_EXPIRES_IN) {
    throw new Error(`expiresIn must be between 1 and ${MAX_EXPIRES_IN}, got ${options.expiresIn}`)
  }
  const url = new URL(options.endpoint)
  const { amzDate, dateStamp } = amzTimestamps(options.now ?? new Date())
  const scope = credentialScope(dateStamp, options.region)

  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${options.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(options.expiresIn),
    'X-Amz-SignedHeaders': 'host',
  }

  const request = canonicalRequest({
    method: options.method,
    path: options.path,
    query,
    headers: { host: url.host },
    // クエリ署名では本文を署名対象にできない
    payloadHash: UNSIGNED_PAYLOAD,
  })
  const key = await signingKey(options.credentials.secretAccessKey, dateStamp, options.region)
  const signature = await calculateSignature(key, await stringToSign(amzDate, scope, request))

  return `${url.origin}${options.path}?${canonicalQueryString(query)}&X-Amz-Signature=${signature}`
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/storage/s3/presign.test.ts
```

Expected: 8 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/storage/s3/presign.ts tests/storage/s3/presign.test.ts
git commit -m "feat(storage): add presigned URL generation for inbox uploads"
```

---

### Task 4: ListObjectsV2 の XML 解析

**Files:**
- Create: `src/storage/s3/list.ts`
- Test: `tests/storage/s3/list.test.ts`

**Interfaces:**
- Consumes: Task 21(Phase 1)の `StorageEntry`
- Produces: `class S3ListParseError extends Error`、`interface ListPage { entries: StorageEntry[]; nextToken: string | null }`、`parseListObjectsV2(xml: string): ListPage`

イベント同期はカーソル以降の範囲取得に依存するため、一覧のページングを正しく扱えることがこのタスクの本質。`DOMParser` は Node のテスト環境に無いので使わず、正規表現で必要な3要素(`Key` / `Size` / `NextContinuationToken`)だけを取り出す。S3 の応答は XML だが、我々が読むのは自分で書いたキーだけなので、これで十分かつ壊れにくい。

`StorageEntry` の形は Phase 1 の `src/storage/provider.ts` に定義済み。実装前にそのファイルを開いてフィールド名を確認すること。

- [ ] **Step 1: 失敗するテストを書く**

`tests/storage/s3/list.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { S3ListParseError, parseListObjectsV2 } from '../../../src/storage/s3/list'

const page = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>mofune</Name>
  <Prefix>midori/events/</Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr</NextContinuationToken>
  <Contents>
    <Key>midori/events/20260807T091234-a1b2.enc</Key>
    <LastModified>2026-08-07T09:12:34.000Z</LastModified>
    <Size>512</Size>
  </Contents>
  <Contents>
    <Key>midori/events/20260807T091300-c3d4.enc</Key>
    <LastModified>2026-08-07T09:13:00.000Z</LastModified>
    <Size>1024</Size>
  </Contents>
</ListBucketResult>`

const lastPage = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>mofune</Name>
  <KeyCount>0</KeyCount>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`

describe('parseListObjectsV2', () => {
  it('extracts every key in document order', () => {
    expect(parseListObjectsV2(page).entries.map((entry) => entry.path)).toEqual([
      'midori/events/20260807T091234-a1b2.enc',
      'midori/events/20260807T091300-c3d4.enc',
    ])
  })

  it('extracts the size of each object', () => {
    expect(parseListObjectsV2(page).entries.map((entry) => entry.size)).toEqual([512, 1024])
  })

  it('returns the continuation token when the result is truncated', () => {
    expect(parseListObjectsV2(page).nextToken).toBe('1ueGcxLPRx1Tr')
  })

  it('returns a null token when the result is not truncated', () => {
    expect(parseListObjectsV2(lastPage).nextToken).toBeNull()
  })

  it('returns no entries for an empty bucket listing', () => {
    expect(parseListObjectsV2(lastPage).entries).toEqual([])
  })

  it('decodes XML entities in keys', () => {
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents>
      <Key>midori/a&amp;b.enc</Key><Size>1</Size></Contents></ListBucketResult>`
    expect(parseListObjectsV2(xml).entries[0]?.path).toBe('midori/a&b.enc')
  })

  it('rejects a response that is not a bucket listing', () => {
    expect(() => parseListObjectsV2('<Error><Code>AccessDenied</Code></Error>')).toThrow(
      S3ListParseError,
    )
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/storage/s3/list.test.ts
```

Expected: FAIL — `Failed to resolve import "../../../src/storage/s3/list"`

- [ ] **Step 3: 実装する**

`src/storage/s3/list.ts`:

```ts
import type { StorageEntry } from '../provider'

export class S3ListParseError extends Error {}

export interface ListPage {
  entries: StorageEntry[]
  /** 続きがある場合の継続トークン。無ければ null。 */
  nextToken: string | null
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function tagValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return match ? decodeEntities(match[1] as string) : null
}

/**
 * ListObjectsV2 の応答から Key / Size / 継続トークンだけを取り出す。
 * DOMParser はテスト環境(node)に無いため使わない。読むのは自分で書いたキーだけ
 * なので、この最小限の解析で足りる。
 */
export function parseListObjectsV2(xml: string): ListPage {
  if (!xml.includes('<ListBucketResult')) {
    throw new S3ListParseError('response is not a ListBucketResult')
  }
  const entries: StorageEntry[] = []
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1] as string
    const key = tagValue(block, 'Key')
    if (key === null) {
      throw new S3ListParseError('a Contents element has no Key')
    }
    entries.push({ path: key, size: Number(tagValue(block, 'Size') ?? 0) })
  }
  const truncated = tagValue(xml, 'IsTruncated') === 'true'
  return { entries, nextToken: truncated ? tagValue(xml, 'NextContinuationToken') : null }
}
```


- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/storage/s3/list.test.ts
```

Expected: 7 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/storage/s3/list.ts tests/storage/s3/list.test.ts
git commit -m "feat(storage): parse ListObjectsV2 responses with pagination"
```

---

### Task 5: S3StorageProvider

**Files:**
- Create: `src/storage/s3.ts`
- Test: `tests/storage/s3.test.ts`

**Interfaces:**
- Consumes: Task 2 の `S3Credentials` / `signRequestHeaders`、Task 4 の `parseListObjectsV2`、Task 21(Phase 1)の `StorageProvider` / `StorageEntry` / `NotFoundError`
- Produces: `interface S3ProviderConfig { endpoint: string; region: string; bucket: string; credentials: S3Credentials }`、`class S3StorageProvider implements StorageProvider`

Phase 1 の `HttpStorageProvider` は公開読み取り専用だった。これは書き込みと一覧に対応する版なので `capabilities` は4つとも `true`。

一覧は継続トークンが尽きるまでページを辿る。`after` が指定された場合は S3 の `start-after` に渡し、カーソル以降だけを取得する(同期の要)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/storage/s3.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { S3StorageProvider } from '../../src/storage/s3'
import { NotFoundError } from '../../src/storage/provider'
import { fromUtf8, utf8 } from '../../src/crypto/bytes'

const config = {
  endpoint: 'https://example.invalid',
  region: 'auto',
  bucket: 'mofune',
  credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
}

function mockFetch(responses: Response[]): { calls: Call[] } {
  const calls: Call[] = []
  let index = 0
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    const response = responses[index] ?? responses[responses.length - 1]
    index += 1
    return Promise.resolve(response as Response)
  })
  return { calls }
}

const listPage = (truncated: boolean, keys: string[], token?: string) =>
  new Response(
    `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>` +
      (token ? `<NextContinuationToken>${token}</NextContinuationToken>` : '') +
      keys.map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`).join('') +
      `</ListBucketResult>`,
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('S3StorageProvider', () => {
  it('declares that it can read, write, list and accept inbox uploads', () => {
    expect(new S3StorageProvider(config).capabilities).toEqual({
      read: true,
      write: true,
      list: true,
      inbox: true,
    })
  })

  it('gets an object from bucket and path', async () => {
    const { calls } = mockFetch([new Response(utf8('payload'))])
    const storage = new S3StorageProvider(config)
    expect(fromUtf8(await storage.get('midori/manifest.json'))).toBe('payload')
    expect(calls[0]?.url).toBe('https://example.invalid/mofune/midori/manifest.json')
    expect(calls[0]?.method).toBe('GET')
  })

  it('signs every request', async () => {
    const { calls } = mockFetch([new Response(utf8('payload'))])
    await new S3StorageProvider(config).get('midori/manifest.json')
    expect(calls[0]?.headers['Authorization']).toContain('AWS4-HMAC-SHA256')
    expect(calls[0]?.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
  })

  it('maps 404 to NotFoundError', async () => {
    mockFetch([new Response('', { status: 404 })])
    await expect(new S3StorageProvider(config).get('midori/missing')).rejects.toThrow(
      NotFoundError,
    )
  })

  it('reports other HTTP failures with the status code', async () => {
    mockFetch([new Response('denied', { status: 403 })])
    await expect(new S3StorageProvider(config).get('midori/manifest.json')).rejects.toThrow(/403/)
  })

  it('puts an object with the body and a signed payload hash', async () => {
    const { calls } = mockFetch([new Response('', { status: 200 })])
    await new S3StorageProvider(config).put('midori/events/1-a.enc', utf8('body'))
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.url).toBe('https://example.invalid/mofune/midori/events/1-a.enc')
    expect(calls[0]?.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('deletes an object', async () => {
    const { calls } = mockFetch([new Response(null, { status: 204 })])
    await new S3StorageProvider(config).delete('midori/events/1-a.enc')
    expect(calls[0]?.method).toBe('DELETE')
  })

  it('lists a single page', async () => {
    mockFetch([listPage(false, ['midori/events/a.enc', 'midori/events/b.enc'])])
    const entries = await new S3StorageProvider(config).list('midori/events/')
    expect(entries.map((entry) => entry.path)).toEqual([
      'midori/events/a.enc',
      'midori/events/b.enc',
    ])
  })

  it('follows the continuation token across pages', async () => {
    const { calls } = mockFetch([
      listPage(true, ['midori/events/a.enc'], 'TOKEN1'),
      listPage(false, ['midori/events/b.enc']),
    ])
    const entries = await new S3StorageProvider(config).list('midori/events/')
    expect(entries.map((entry) => entry.path)).toEqual([
      'midori/events/a.enc',
      'midori/events/b.enc',
    ])
    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toContain('continuation-token=TOKEN1')
  })

  it('passes the cursor to start-after so only newer objects come back', async () => {
    const { calls } = mockFetch([listPage(false, [])])
    await new S3StorageProvider(config).list('midori/events/', 'midori/events/a.enc')
    expect(calls[0]?.url).toContain('start-after=midori%2Fevents%2Fa.enc')
  })

  it('sends list-type=2 and the prefix', async () => {
    const { calls } = mockFetch([listPage(false, [])])
    await new S3StorageProvider(config).list('midori/events/')
    expect(calls[0]?.url).toContain('list-type=2')
    expect(calls[0]?.url).toContain('prefix=midori%2Fevents%2F')
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/storage/s3.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/storage/s3"`

- [ ] **Step 3: 実装する**

`src/storage/s3.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import type { StorageCapabilities, StorageEntry, StorageProvider } from './provider'
import { NotFoundError } from './provider'
import { parseListObjectsV2 } from './s3/list'
import type { S3Credentials } from './s3/sigv4'
import { signRequestHeaders } from './s3/sigv4'

export interface S3ProviderConfig {
  /** スキームとホストまで。末尾のスラッシュは付けない。 */
  endpoint: string
  region: string
  bucket: string
  credentials: S3Credentials
}

export class S3StorageProvider implements StorageProvider {
  readonly capabilities: StorageCapabilities = {
    read: true,
    write: true,
    list: true,
    inbox: true,
  }

  constructor(private readonly config: S3ProviderConfig) {}

  private objectUrl(path: string, query?: Record<string, string>): URL {
    const url = new URL(`${this.config.endpoint}/${this.config.bucket}/${path}`)
    for (const [name, value] of Object.entries(query ?? {})) {
      url.searchParams.set(name, value)
    }
    return url
  }

  private async send(method: string, url: URL, payload?: Bytes): Promise<Response> {
    const headers = await signRequestHeaders({
      credentials: this.config.credentials,
      region: this.config.region,
      method,
      url,
      payload,
    })
    const response = await fetch(url.toString(), {
      method,
      headers,
      ...(payload ? { body: payload } : {}),
    })
    if (response.status === 404) {
      throw new NotFoundError(`no object at "${url.pathname}"`)
    }
    if (!response.ok) {
      throw new Error(`storage request failed with ${response.status} for "${url.pathname}"`)
    }
    return response
  }

  async get(path: string): Promise<Bytes> {
    const response = await this.send('GET', this.objectUrl(path))
    return new Uint8Array(await response.arrayBuffer())
  }

  async put(path: string, data: Bytes): Promise<void> {
    await this.send('PUT', this.objectUrl(path), data)
  }

  async delete(path: string): Promise<void> {
    await this.send('DELETE', this.objectUrl(path))
  }

  async list(prefix: string, after?: string): Promise<StorageEntry[]> {
    const entries: StorageEntry[] = []
    let token: string | null = null
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix }
      if (after) query['start-after'] = after
      if (token) query['continuation-token'] = token
      // 一覧はバケット直下に対する操作なのでオブジェクトパスは空
      const url = new URL(`${this.config.endpoint}/${this.config.bucket}`)
      for (const [name, value] of Object.entries(query)) {
        url.searchParams.set(name, value)
      }
      const page = parseListObjectsV2(await (await this.send('GET', url)).text())
      entries.push(...page.entries)
      token = page.nextToken
    } while (token !== null)
    return entries
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/storage/s3.test.ts
```

Expected: 11 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/storage/s3.ts tests/storage/s3.test.ts
git commit -m "feat(storage): add read-write S3-compatible storage provider"
```

---

### Task 6: 書き込み資格情報の保管

**Files:**
- Create: `src/group/storage-credentials.ts`
- Test: `tests/group/storage-credentials.test.ts`

**Interfaces:**
- Consumes: Task 5(Phase 1)の `sealEnvelopeFor` / `openEnvelope` / `DecryptionError`、Task 8(Phase 1)の `keyId`、Task 9(Phase 1)の `STAFF_SCOPE`、Task 5 の `S3ProviderConfig`、Task 21(Phase 1)の `StorageProvider`
- Produces: `class StorageCredentialsError extends Error`、`interface StorageSettings { provider: 's3'; endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }`、`const STORAGE_SETTINGS_PATH`、`storageSettingsPath(groupId: string): string`、`writeStorageSettings(options: { storage: StorageProvider; groupId: string; settings: StorageSettings; staffKey: CryptoKey; generation: number }): Promise<void>` / `readStorageSettings(options: { storage: StorageProvider; groupId: string; keys: ReadonlyMap<string, CryptoKey> }): Promise<StorageSettings>` / `toProviderConfig(settings: StorageSettings): S3ProviderConfig`

設計書 §7.4 の実装。投稿権限を持つのは管理者と担当者なので、資格情報は staff スコープで暗号化する(管理者のキーストアに置くと担当者が投稿できなくなる)。参加者は復号できず、上りは presigned URL で行う。

**このオブジェクトを IndexedDB にキャッシュしてはならない**(Global Constraints)。必要なときにストレージから取得して復号し、メモリ上のセッションにだけ保持する。

- [ ] **Step 1: 失敗するテストを書く**

`tests/group/storage-credentials.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  StorageCredentialsError,
  readStorageSettings,
  storageSettingsPath,
  toProviderConfig,
  writeStorageSettings,
} from '../../src/group/storage-credentials'
import type { StorageSettings } from '../../src/group/storage-credentials'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'
import { keyId } from '../../src/crypto/keyring'
import { STAFF_SCOPE } from '../../src/crypto/roster'

const settings: StorageSettings = {
  provider: 's3',
  endpoint: 'https://account.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'mofune',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
}

async function seeded(): Promise<{
  storage: MemoryStorageProvider
  staffKey: CryptoKey
  staffKeyId: string
}> {
  const storage = new MemoryStorageProvider()
  const staffKey = await generateAesKey()
  const staffKeyId = keyId(STAFF_SCOPE, 1)
  await writeStorageSettings({ storage, groupId: 'midori', settings, staffKey, generation: 1 })
  return { storage, staffKey, staffKeyId }
}

describe('storage settings', () => {
  it('writes to the documented path', () => {
    expect(storageSettingsPath('midori')).toBe('midori/settings/storage.enc')
  })

  it('round-trips the settings for a staff key holder', async () => {
    const { storage, staffKey, staffKeyId } = await seeded()
    const keys = new Map([[staffKeyId, staffKey]])
    expect(await readStorageSettings({ storage, groupId: 'midori', keys })).toEqual(settings)
  })

  it('addresses the object to the staff scope only', async () => {
    const { storage } = await seeded()
    const { readKeyIds } = await import('../../src/crypto/envelope')
    expect(readKeyIds(await storage.get(storageSettingsPath('midori')))).toEqual([
      keyId(STAFF_SCOPE, 1),
    ])
  })

  it('cannot be read by a member who holds only the all scope key', async () => {
    const { storage } = await seeded()
    const keys = new Map([[keyId('all', 1), await generateAesKey()]])
    await expect(readStorageSettings({ storage, groupId: 'midori', keys })).rejects.toThrow(
      StorageCredentialsError,
    )
  })

  it('does not leave the secret access key in plaintext on storage', async () => {
    const { storage } = await seeded()
    const raw = new TextDecoder().decode(await storage.get(storageSettingsPath('midori')))
    expect(raw).not.toContain('SECRET')
    expect(raw).not.toContain('AKID')
  })

  it('reports a missing settings object as a credentials error', async () => {
    const storage = new MemoryStorageProvider()
    const keys = new Map([[keyId(STAFF_SCOPE, 1), await generateAesKey()]])
    await expect(readStorageSettings({ storage, groupId: 'midori', keys })).rejects.toThrow(
      StorageCredentialsError,
    )
  })

  it('converts settings into a provider config', () => {
    expect(toProviderConfig(settings)).toEqual({
      endpoint: 'https://account.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'mofune',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
    })
  })

  it('can be replaced by writing a newer generation', async () => {
    const { storage, staffKey } = await seeded()
    const rotated: StorageSettings = { ...settings, accessKeyId: 'AKID2', secretAccessKey: 'S2' }
    const newKey = await generateAesKey()
    await writeStorageSettings({
      storage,
      groupId: 'midori',
      settings: rotated,
      staffKey: newKey,
      generation: 2,
    })
    const keys = new Map([[keyId(STAFF_SCOPE, 2), newKey]])
    expect(await readStorageSettings({ storage, groupId: 'midori', keys })).toEqual(rotated)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/group/storage-credentials.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/group/storage-credentials"`

- [ ] **Step 3: 実装する**

`src/group/storage-credentials.ts`:

```ts
import { fromUtf8, utf8 } from '../crypto/bytes'
import { openEnvelope, sealEnvelopeFor } from '../crypto/envelope'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import type { S3ProviderConfig } from '../storage/s3'
import type { StorageProvider } from '../storage/provider'

export class StorageCredentialsError extends Error {}

export interface StorageSettings {
  provider: 's3'
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export function storageSettingsPath(groupId: string): string {
  return `${groupId}/settings/storage.enc`
}

export async function writeStorageSettings(options: {
  storage: StorageProvider
  groupId: string
  settings: StorageSettings
  staffKey: CryptoKey
  generation: number
}): Promise<void> {
  const sealed = await sealEnvelopeFor(
    [{ keyId: keyId(STAFF_SCOPE, options.generation), key: options.staffKey }],
    utf8(JSON.stringify(options.settings)),
  )
  await options.storage.put(storageSettingsPath(options.groupId), sealed)
}

/**
 * staff スコープ鍵を持つ者(管理者・担当者)だけが読める。
 * 結果はメモリ上のセッションにのみ保持し、IndexedDB に書いてはならない。
 */
export async function readStorageSettings(options: {
  storage: StorageProvider
  groupId: string
  keys: ReadonlyMap<string, CryptoKey>
}): Promise<StorageSettings> {
  let sealed
  try {
    sealed = await options.storage.get(storageSettingsPath(options.groupId))
  } catch {
    throw new StorageCredentialsError('no storage settings have been written for this group')
  }
  try {
    return JSON.parse(fromUtf8(await openEnvelope(options.keys, sealed))) as StorageSettings
  } catch {
    throw new StorageCredentialsError('storage settings could not be decrypted with these keys')
  }
}

export function toProviderConfig(settings: StorageSettings): S3ProviderConfig {
  return {
    endpoint: settings.endpoint,
    region: settings.region,
    bucket: settings.bucket,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/group/storage-credentials.test.ts
```

Expected: 8 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/group/storage-credentials.ts tests/group/storage-credentials.test.ts
git commit -m "feat(group): store write credentials under the staff scope"
```

---

### Task 7: イベント形式

**Files:**
- Create: `src/sync/events.ts`
- Test: `tests/sync/events.test.ts`

**Interfaces:**
- Consumes: Task 2(Phase 1)の `Bytes` / `toHex` / `utf8` / `fromUtf8`、Task 3(Phase 1)の `randomBytes`、Task 5(Phase 1)の `sealEnvelopeFor` / `openEnvelope` / `DecryptionError` / `SealTarget`
- Produces: `type EventType = 'MESSAGE_CREATED' | 'FILE_ADDED' | 'MEMBER_UPDATED'`、`class EventFormatError extends Error`、`interface GroupEvent { id: string; type: EventType; author: string; at: string; payload: Record<string, unknown> }`、`newEventId(now?: Date): string` / `eventPathFor(groupId: string, id: string): string` / `compareEventIds(a: string, b: string): number` / `sealEvent(event: GroupEvent, targets: SealTarget[]): Promise<Bytes>` / `openEvent(keys: ReadonlyMap<string, CryptoKey>, bytes: Bytes): Promise<GroupEvent>`

設計書 §6.1 の実装。1変更=1ファイルの追記専用なので書き込み競合が起きない。ファイル名 `{timestamp}-{random}` が時系列にソートできることが同期カーソルの前提であり、このタスクで最も重要な性質。

イベント本文(author・宛先・参照先)は暗号化する。平文で出るのはファイル名(=時刻)とサイズだけ(要件書 §5.3)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/sync/events.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  EventFormatError,
  compareEventIds,
  eventPathFor,
  newEventId,
  openEvent,
  sealEvent,
} from '../../src/sync/events'
import type { GroupEvent } from '../../src/sync/events'
import { generateAesKey } from '../../src/crypto/symmetric'
import { readKeyIds } from '../../src/crypto/envelope'

const event: GroupEvent = {
  id: '20260807T091234Z-a1b2c3d4',
  type: 'MESSAGE_CREATED',
  author: 'u_tanaka',
  at: '2026-08-07T09:12:34.000Z',
  payload: { messageId: 'm_1', scopes: ['sg_a', 'sg_a_pickup'] },
}

describe('newEventId', () => {
  it('starts with the ISO 8601 basic timestamp', () => {
    expect(newEventId(new Date('2026-08-07T09:12:34.000Z'))).toMatch(
      /^20260807T091234Z-[0-9a-f]{8}$/,
    )
  })

  it('is unique for the same instant', () => {
    const now = new Date('2026-08-07T09:12:34.000Z')
    expect(newEventId(now)).not.toBe(newEventId(now))
  })
})

describe('compareEventIds', () => {
  it('orders ids by time', () => {
    const early = '20260807T091234Z-ffffffff'
    const late = '20260807T091235Z-00000000'
    expect(compareEventIds(early, late)).toBeLessThan(0)
    expect(compareEventIds(late, early)).toBeGreaterThan(0)
  })

  it('sorts lexicographically, which is what storage listing gives us', () => {
    const ids = ['20260807T091300Z-b', '20260806T235959Z-a', '20260807T091234Z-c']
    expect([...ids].sort(compareEventIds)).toEqual([
      '20260806T235959Z-a',
      '20260807T091234Z-c',
      '20260807T091300Z-b',
    ])
  })

  it('is stable for identical ids', () => {
    expect(compareEventIds(event.id, event.id)).toBe(0)
  })
})

describe('eventPathFor', () => {
  it('places events under the group events prefix', () => {
    expect(eventPathFor('midori', event.id)).toBe(
      'midori/events/20260807T091234Z-a1b2c3d4.enc',
    )
  })
})

describe('sealEvent / openEvent', () => {
  it('round-trips an event for a scope key holder', async () => {
    const key = await generateAesKey()
    const sealed = await sealEvent(event, [{ keyId: 'sg_a:v1', key }])
    expect(await openEvent(new Map([['sg_a:v1', key]]), sealed)).toEqual(event)
  })

  it('addresses the event to every scope it was posted to', async () => {
    const team = await generateAesKey()
    const pickup = await generateAesKey()
    const sealed = await sealEvent(event, [
      { keyId: 'sg_a:v1', key: team },
      { keyId: 'sg_a_pickup:v1', key: pickup },
    ])
    expect(readKeyIds(sealed)).toEqual(['sg_a:v1', 'sg_a_pickup:v1'])
    expect(await openEvent(new Map([['sg_a_pickup:v1', pickup]]), sealed)).toEqual(event)
  })

  it('does not leak the author or the payload into the ciphertext', async () => {
    const key = await generateAesKey()
    const sealed = await sealEvent(event, [{ keyId: 'sg_a:v1', key }])
    const raw = new TextDecoder().decode(sealed)
    expect(raw).not.toContain('u_tanaka')
    expect(raw).not.toContain('m_1')
  })

  it('cannot be opened without a matching key', async () => {
    const sealed = await sealEvent(event, [{ keyId: 'sg_a:v1', key: await generateAesKey() }])
    const stranger = new Map([['sg_b:v1', await generateAesKey()]])
    await expect(openEvent(stranger, sealed)).rejects.toThrow()
  })

  it('rejects an event whose decrypted body is not a valid event', async () => {
    const key = await generateAesKey()
    const { sealEnvelopeFor } = await import('../../src/crypto/envelope')
    const { utf8 } = await import('../../src/crypto/bytes')
    const bogus = await sealEnvelopeFor([{ keyId: 'sg_a:v1', key }], utf8('{"nope":true}'))
    await expect(openEvent(new Map([['sg_a:v1', key]]), bogus)).rejects.toThrow(EventFormatError)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/sync/events.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/sync/events"`

- [ ] **Step 3: 実装する**

`src/sync/events.ts`:

```ts
import type { Bytes } from '../crypto/bytes'
import { fromUtf8, toHex, utf8 } from '../crypto/bytes'
import type { SealTarget } from '../crypto/envelope'
import { openEnvelope, sealEnvelopeFor } from '../crypto/envelope'
import { randomBytes } from '../crypto/symmetric'

export class EventFormatError extends Error {}

export type EventType = 'MESSAGE_CREATED' | 'FILE_ADDED' | 'MEMBER_UPDATED'

export interface GroupEvent {
  /** `{ISO8601基本形式}-{ランダム8桁hex}`。辞書順=時系列順。 */
  id: string
  type: EventType
  author: string
  /** ISO 8601 拡張形式。 */
  at: string
  payload: Record<string, unknown>
}

const EVENT_TYPES: readonly string[] = ['MESSAGE_CREATED', 'FILE_ADDED', 'MEMBER_UPDATED']

/**
 * 時系列にソートできる ID。同一時刻の衝突はランダム部で避ける。
 * ストレージの一覧は辞書順で返るため、この形式がそのままカーソルになる。
 */
export function newEventId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return `${stamp}-${toHex(randomBytes(4))}`
}

export function eventPathFor(groupId: string, id: string): string {
  return `${groupId}/events/${id}.enc`
}

export function compareEventIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export async function sealEvent(event: GroupEvent, targets: SealTarget[]): Promise<Bytes> {
  return sealEnvelopeFor(targets, utf8(JSON.stringify(event)))
}

export async function openEvent(
  keys: ReadonlyMap<string, CryptoKey>,
  bytes: Bytes,
): Promise<GroupEvent> {
  const plaintext = await openEnvelope(keys, bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(plaintext))
  } catch {
    throw new EventFormatError('event body is not valid JSON')
  }
  const event = parsed as GroupEvent
  if (event === null || typeof event !== 'object') {
    throw new EventFormatError('event body is not an object')
  }
  if (typeof event.id !== 'string' || typeof event.author !== 'string') {
    throw new EventFormatError('event is missing required fields')
  }
  if (!EVENT_TYPES.includes(event.type)) {
    throw new EventFormatError(`unknown event type ${String(event.type)}`)
  }
  return event
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/sync/events.test.ts
```

Expected: 11 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/sync/events.ts tests/sync/events.test.ts
git commit -m "feat(sync): add append-only encrypted event log format"
```

---

### Task 8: グループ単位の Dexie スキーマ

**Files:**
- Create: `src/db/group-db.ts`
- Test: `tests/db/group-db.test.ts`

**Interfaces:**
- Consumes: Task 7 の `GroupEvent`、Task 9(Phase 1)の `RosterContents`
- Produces: `interface CachedMessage { id: string; scopes: string[]; author: string; at: string; body: string; attachments: string[] }`、`interface OutboxItem { id: string; kind: 'event' | 'inbox'; path: string; body: Bytes; queuedAt: string; attempts: number }`、`interface SyncState { key: 'cursor' | 'lastReadAt'; value: string | null }`、`class GroupDatabase extends Dexie`、`openGroupDatabase(groupId: string): GroupDatabase` / `closeGroupDatabase(groupId: string): Promise<void>` / `deleteGroupDatabase(groupId: string): Promise<void>`

設計書 §6.5 の実装。DB 名はグループIDで名前空間を分ける(`mofune_{group_id}`)。`deleteGroupDatabase` は設計書 §5.4「この端末の登録を解除」で使う。

**キャッシュしてよいのは復号済みコンテンツまで。** 秘密鍵・パスワード・ストレージ資格情報を入れてはならない(Global Constraints)。

テストは `fake-indexeddb` を使う(Phase 1 で devDependency 済み)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/db/group-db.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  closeGroupDatabase,
  deleteGroupDatabase,
  openGroupDatabase,
} from '../../src/db/group-db'
import type { OutboxItem } from '../../src/db/group-db'
import { utf8 } from '../../src/crypto/bytes'

const item: OutboxItem = {
  id: '20260807T091234Z-a1b2c3d4',
  kind: 'event',
  path: 'midori/events/20260807T091234Z-a1b2c3d4.enc',
  body: utf8('sealed'),
  queuedAt: '2026-08-07T09:12:34.000Z',
  attempts: 0,
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
  await deleteGroupDatabase('aozora')
})

describe('group database', () => {
  it('namespaces the database by group id', () => {
    expect(openGroupDatabase('midori').name).toBe('mofune_midori')
    expect(openGroupDatabase('aozora').name).toBe('mofune_aozora')
  })

  it('returns the same instance for repeated opens of one group', () => {
    expect(openGroupDatabase('midori')).toBe(openGroupDatabase('midori'))
  })

  it('keeps two groups isolated', async () => {
    await openGroupDatabase('midori').outbox.put(item)
    expect(await openGroupDatabase('aozora').outbox.count()).toBe(0)
    expect(await openGroupDatabase('midori').outbox.count()).toBe(1)
  })

  it('stores and reads back an outbox item with its body intact', async () => {
    const db = openGroupDatabase('midori')
    await db.outbox.put(item)
    const stored = await db.outbox.get(item.id)
    expect(stored?.path).toBe(item.path)
    expect(new TextDecoder().decode(stored?.body)).toBe('sealed')
  })

  it('stores messages and finds them by id', async () => {
    const db = openGroupDatabase('midori')
    await db.messages.put({
      id: 'm_1',
      scopes: ['sg_a'],
      author: 'u_tanaka',
      at: '2026-08-07T09:12:34.000Z',
      body: '来週の集まりについて',
      attachments: [],
    })
    expect((await db.messages.get('m_1'))?.body).toBe('来週の集まりについて')
  })

  it('records processed events so they are not applied twice', async () => {
    const db = openGroupDatabase('midori')
    await db.events.put({
      id: item.id,
      type: 'MESSAGE_CREATED',
      author: 'u_tanaka',
      at: '2026-08-07T09:12:34.000Z',
      payload: {},
    })
    expect(await db.events.get(item.id)).toBeDefined()
  })

  it('holds the sync cursor as a single keyed row', async () => {
    const db = openGroupDatabase('midori')
    await db.syncState.put({ key: 'cursor', value: item.id })
    await db.syncState.put({ key: 'cursor', value: 'newer' })
    expect(await db.syncState.count()).toBe(1)
    expect((await db.syncState.get('cursor'))?.value).toBe('newer')
  })

  it('deletes everything for a group when the device is unregistered', async () => {
    const db = openGroupDatabase('midori')
    await db.outbox.put(item)
    await deleteGroupDatabase('midori')
    expect(await openGroupDatabase('midori').outbox.count()).toBe(0)
  })

  it('closes without deleting the data', async () => {
    await openGroupDatabase('midori').outbox.put(item)
    await closeGroupDatabase('midori')
    expect(await openGroupDatabase('midori').outbox.count()).toBe(1)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/db/group-db.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/db/group-db"`

- [ ] **Step 3: 実装する**

`src/db/group-db.ts`:

```ts
import Dexie from 'dexie'
import type { Table } from 'dexie'
import type { Bytes } from '../crypto/bytes'
import type { RosterContents } from '../crypto/roster'
import type { GroupEvent } from '../sync/events'

export interface CachedMessage {
  id: string
  scopes: string[]
  author: string
  at: string
  body: string
  /** files/ に置かれた添付の id。 */
  attachments: string[]
}

export interface CachedFile {
  id: string
  mediaType: string
  size: number
  blob: Bytes
  cachedAt: string
}

export interface CachedRoster {
  groupId: string
  contents: RosterContents
}

export interface OutboxItem {
  id: string
  kind: 'event' | 'inbox'
  /** 送信先のストレージパス、または presigned URL。 */
  path: string
  body: Bytes
  queuedAt: string
  attempts: number
}

export interface SyncState {
  key: 'cursor' | 'lastReadAt'
  value: string | null
}

export class GroupDatabase extends Dexie {
  messages!: Table<CachedMessage, string>
  files!: Table<CachedFile, string>
  events!: Table<GroupEvent, string>
  roster!: Table<CachedRoster, string>
  outbox!: Table<OutboxItem, string>
  syncState!: Table<SyncState, string>

  constructor(groupId: string) {
    super(`mofune_${groupId}`)
    this.version(1).stores({
      messages: 'id, at',
      files: 'id, cachedAt',
      events: 'id',
      roster: 'groupId',
      outbox: 'id, queuedAt',
      syncState: 'key',
    })
  }
}

const open = new Map<string, GroupDatabase>()

/** グループごとに1インスタンスを使い回す。IndexedDB は名前で分離される。 */
export function openGroupDatabase(groupId: string): GroupDatabase {
  const existing = open.get(groupId)
  if (existing) return existing
  const db = new GroupDatabase(groupId)
  open.set(groupId, db)
  return db
}

export async function closeGroupDatabase(groupId: string): Promise<void> {
  const db = open.get(groupId)
  if (!db) return
  db.close()
  open.delete(groupId)
}

/** 設計書 §5.4「この端末の登録を解除」で使う。復号済みキャッシュを消す。 */
export async function deleteGroupDatabase(groupId: string): Promise<void> {
  await closeGroupDatabase(groupId)
  await Dexie.delete(`mofune_${groupId}`)
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/db/group-db.test.ts
```

Expected: 9 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/db/group-db.ts tests/db/group-db.test.ts
git commit -m "feat(db): add per-group Dexie schema for cached content and outbox"
```

---

### Task 9: カーソル差分同期

**Files:**
- Create: `src/sync/sync.ts`
- Test: `tests/sync/sync.test.ts`

**Interfaces:**
- Consumes: Task 7 の `GroupEvent` / `compareEventIds` / `eventPathFor` / `openEvent`、Task 8 の `GroupDatabase`、Task 21(Phase 1)の `StorageProvider`
- Produces: `interface SyncResult { applied: number; skipped: number; cursor: string | null }`、`readCursor(db: GroupDatabase): Promise<string | null>` / `writeCursor(db: GroupDatabase, cursor: string): Promise<void>` / `syncGroup(options: { storage: StorageProvider; groupId: string; keys: ReadonlyMap<string, CryptoKey>; db: GroupDatabase }): Promise<SyncResult>`

設計書 §6.1 の実装。カーソル以降のイベントだけを範囲取得する。

**復号できないイベントは正常系である。** 自分が所属していないサブグループ宛のイベントは開けないので、エラーにせず `skipped` として数え、カーソルは進める(進めないと永久に同じ位置で止まる)。ここがこのタスクで最も間違えやすい。

- [ ] **Step 1: 失敗するテストを書く**

`tests/sync/sync.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { readCursor, syncGroup, writeCursor } from '../../src/sync/sync'
import { eventPathFor, sealEvent } from '../../src/sync/events'
import type { GroupEvent } from '../../src/sync/events'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { generateAesKey } from '../../src/crypto/symmetric'

const teamKeyId = 'sg_a:v1'
const otherKeyId = 'sg_b:v1'

function eventAt(id: string, author = 'u_tanaka'): GroupEvent {
  return {
    id,
    type: 'MESSAGE_CREATED',
    author,
    at: '2026-08-07T09:12:34.000Z',
    payload: { messageId: `m_${id}` },
  }
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('cursor', () => {
  it('is null before the first sync', async () => {
    expect(await readCursor(openGroupDatabase('midori'))).toBeNull()
  })

  it('round-trips', async () => {
    const db = openGroupDatabase('midori')
    await writeCursor(db, '20260807T091234Z-aaaa')
    expect(await readCursor(db)).toBe('20260807T091234Z-aaaa')
  })
})

describe('syncGroup', () => {
  it('applies every event on a first sync', async () => {
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    for (const id of ['20260807T091234Z-aaaa', '20260807T091300Z-bbbb']) {
      await storage.put(eventPathFor('midori', id), await sealEvent(eventAt(id), [{ keyId: teamKeyId, key }]))
    }
    const db = openGroupDatabase('midori')
    const result = await syncGroup({
      storage,
      groupId: 'midori',
      keys: new Map([[teamKeyId, key]]),
      db,
    })
    expect(result.applied).toBe(2)
    expect(await db.events.count()).toBe(2)
  })

  it('advances the cursor to the newest event it saw', async () => {
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    for (const id of ['20260807T091234Z-aaaa', '20260807T091300Z-bbbb']) {
      await storage.put(eventPathFor('midori', id), await sealEvent(eventAt(id), [{ keyId: teamKeyId, key }]))
    }
    const db = openGroupDatabase('midori')
    const result = await syncGroup({
      storage,
      groupId: 'midori',
      keys: new Map([[teamKeyId, key]]),
      db,
    })
    expect(result.cursor).toBe('20260807T091300Z-bbbb')
    expect(await readCursor(db)).toBe('20260807T091300Z-bbbb')
  })

  it('applies nothing on a second sync with no new events', async () => {
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    const id = '20260807T091234Z-aaaa'
    await storage.put(eventPathFor('midori', id), await sealEvent(eventAt(id), [{ keyId: teamKeyId, key }]))
    const db = openGroupDatabase('midori')
    const keys = new Map([[teamKeyId, key]])
    await syncGroup({ storage, groupId: 'midori', keys, db })
    const second = await syncGroup({ storage, groupId: 'midori', keys, db })
    expect(second.applied).toBe(0)
  })

  it('applies only the events newer than the cursor', async () => {
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    const keys = new Map([[teamKeyId, key]])
    const db = openGroupDatabase('midori')
    const first = '20260807T091234Z-aaaa'
    await storage.put(eventPathFor('midori', first), await sealEvent(eventAt(first), [{ keyId: teamKeyId, key }]))
    await syncGroup({ storage, groupId: 'midori', keys, db })

    const second = '20260807T091300Z-bbbb'
    await storage.put(eventPathFor('midori', second), await sealEvent(eventAt(second), [{ keyId: teamKeyId, key }]))
    const result = await syncGroup({ storage, groupId: 'midori', keys, db })
    expect(result.applied).toBe(1)
    expect(result.cursor).toBe(second)
  })

  it('skips events addressed to a scope the user is not in, and still advances', async () => {
    const storage = new MemoryStorageProvider()
    const mine = await generateAesKey()
    const theirs = await generateAesKey()
    const visible = '20260807T091234Z-aaaa'
    const hidden = '20260807T091300Z-bbbb'
    await storage.put(eventPathFor('midori', visible), await sealEvent(eventAt(visible), [{ keyId: teamKeyId, key: mine }]))
    await storage.put(eventPathFor('midori', hidden), await sealEvent(eventAt(hidden), [{ keyId: otherKeyId, key: theirs }]))

    const db = openGroupDatabase('midori')
    const result = await syncGroup({
      storage,
      groupId: 'midori',
      keys: new Map([[teamKeyId, mine]]),
      db,
    })
    expect(result.applied).toBe(1)
    expect(result.skipped).toBe(1)
    // カーソルを進めないと、この端末は永久に同じ位置で止まる
    expect(result.cursor).toBe(hidden)
  })

  it('applies events in chronological order regardless of listing order', async () => {
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    const ids = ['20260807T091300Z-bbbb', '20260806T235959Z-aaaa', '20260807T091234Z-cccc']
    for (const id of ids) {
      await storage.put(eventPathFor('midori', id), await sealEvent(eventAt(id), [{ keyId: teamKeyId, key }]))
    }
    const db = openGroupDatabase('midori')
    await syncGroup({ storage, groupId: 'midori', keys: new Map([[teamKeyId, key]]), db })
    const stored = await db.events.toArray()
    expect(stored.map((event) => event.id)).toEqual([...ids].sort())
  })

  it('is idempotent when the same event is seen twice', async () => {
    const storage = new MemoryStorageProvider()
    const key = await generateAesKey()
    const id = '20260807T091234Z-aaaa'
    await storage.put(eventPathFor('midori', id), await sealEvent(eventAt(id), [{ keyId: teamKeyId, key }]))
    const db = openGroupDatabase('midori')
    const keys = new Map([[teamKeyId, key]])
    await syncGroup({ storage, groupId: 'midori', keys, db })
    await writeCursor(db, '')
    await syncGroup({ storage, groupId: 'midori', keys, db })
    expect(await db.events.count()).toBe(1)
  })

  it('leaves the cursor alone when there is nothing to sync', async () => {
    const db = openGroupDatabase('midori')
    const result = await syncGroup({
      storage: new MemoryStorageProvider(),
      groupId: 'midori',
      keys: new Map(),
      db,
    })
    expect(result).toEqual({ applied: 0, skipped: 0, cursor: null })
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/sync/sync.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/sync/sync"`

- [ ] **Step 3: 実装する**

`src/sync/sync.ts`:

```ts
import type { GroupDatabase } from '../db/group-db'
import type { StorageProvider } from '../storage/provider'
import { compareEventIds, openEvent } from './events'

export interface SyncResult {
  /** 復号して適用できたイベント数。 */
  applied: number
  /** 自分の鍵では開けなかったイベント数(正常系)。 */
  skipped: number
  cursor: string | null
}

export async function readCursor(db: GroupDatabase): Promise<string | null> {
  return (await db.syncState.get('cursor'))?.value ?? null
}

export async function writeCursor(db: GroupDatabase, cursor: string): Promise<void> {
  await db.syncState.put({ key: 'cursor', value: cursor })
}

/** ストレージパスからイベント ID を取り出す。 */
function idFromPath(path: string): string {
  return (path.split('/').pop() ?? '').replace(/\.enc$/, '')
}

/**
 * カーソル以降のイベントだけを取得して適用する。
 *
 * 自分が所属していないサブグループ宛のイベントは復号できないが、これは異常では
 * ないので skipped として数え、カーソルは進める。進めないとその端末は同じ位置で
 * 永久に止まる。
 */
export async function syncGroup(options: {
  storage: StorageProvider
  groupId: string
  keys: ReadonlyMap<string, CryptoKey>
  db: GroupDatabase
}): Promise<SyncResult> {
  const cursor = await readCursor(options.db)
  const prefix = `${options.groupId}/events/`
  const after = cursor ? `${prefix}${cursor}.enc` : undefined
  const entries = await options.storage.list(prefix, after)

  const ids = entries.map((entry) => idFromPath(entry.path)).sort(compareEventIds)
  let applied = 0
  let skipped = 0

  for (const id of ids) {
    const sealed = await options.storage.get(`${prefix}${id}.enc`)
    try {
      const event = await openEvent(options.keys, sealed)
      await options.db.events.put(event)
      applied += 1
    } catch {
      skipped += 1
    }
  }

  const newest = ids.length > 0 ? (ids[ids.length - 1] as string) : null
  if (newest !== null) {
    await writeCursor(options.db, newest)
  }
  return { applied, skipped, cursor: newest ?? cursor }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/sync/sync.test.ts
```

Expected: 10 tests passed


- [ ] **Step 5: コミット**

```bash
git add src/sync/sync.ts tests/sync/sync.test.ts
git commit -m "feat(sync): add cursor-based incremental event sync"
```

---

### Task 10: 保留キューと再送

**Files:**
- Create: `src/sync/outbox.ts`
- Test: `tests/sync/outbox.test.ts`

**Interfaces:**
- Consumes: Task 8 の `GroupDatabase` / `OutboxItem`、Task 21(Phase 1)の `StorageProvider`
- Produces: `interface FlushResult { sent: number; failed: number }`、`enqueue(db: GroupDatabase, item: Omit<OutboxItem, 'queuedAt' | 'attempts'>): Promise<void>` / `pending(db: GroupDatabase): Promise<OutboxItem[]>` / `flushOutbox(options: { db: GroupDatabase; storage: StorageProvider }): Promise<FlushResult>`

要件書 §4.9 の実装。オフライン時の投稿をローカルに貯め、オンライン復帰時に送る。

**送信できなかった項目はキューに残す。** 1件の失敗で以降が止まらないよう、失敗しても次の項目へ進み、`attempts` を増やす。成功した項目だけをキューから消す。

- [ ] **Step 1: 失敗するテストを書く**

`tests/sync/outbox.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { enqueue, flushOutbox, pending } from '../../src/sync/outbox'
import { deleteGroupDatabase, openGroupDatabase } from '../../src/db/group-db'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { fromUtf8, utf8 } from '../../src/crypto/bytes'
import type { StorageProvider } from '../../src/storage/provider'
import type { Bytes } from '../../src/crypto/bytes'

const draft = {
  id: '20260807T091234Z-aaaa',
  kind: 'event' as const,
  path: 'midori/events/20260807T091234Z-aaaa.enc',
  body: utf8('sealed'),
}

/**
 * put だけを差し替えたプロバイダを作る。クラスインスタンスをスプレッドしても
 * プロトタイプ上のメソッドは複製されないので、明示的に委譲する。
 */
function withPut(put: (path: string, data: Bytes) => Promise<void>): StorageProvider {
  const inner = new MemoryStorageProvider()
  return {
    capabilities: inner.capabilities,
    get: (path) => inner.get(path),
    list: (prefix, after) => inner.list(prefix, after),
    delete: (path) => inner.delete(path),
    put,
  }
}

/** put が常に失敗するプロバイダ。オフライン相当。 */
function offline(): StorageProvider {
  return withPut(() => Promise.reject(new Error('offline')))
}

beforeEach(async () => {
  await deleteGroupDatabase('midori')
})

describe('outbox', () => {
  it('records the queue time and starts the attempt count at zero', async () => {
    const db = openGroupDatabase('midori')
    await enqueue(db, draft)
    const [item] = await pending(db)
    expect(item?.attempts).toBe(0)
    expect(Date.parse(item?.queuedAt ?? '')).not.toBeNaN()
  })

  it('returns pending items oldest first', async () => {
    const db = openGroupDatabase('midori')
    await enqueue(db, { ...draft, id: 'b' })
    await enqueue(db, { ...draft, id: 'a' })
    const items = await pending(db)
    expect(items).toHaveLength(2)
    expect(Date.parse(items[0]?.queuedAt ?? '')).toBeLessThanOrEqual(
      Date.parse(items[1]?.queuedAt ?? ''),
    )
  })

  it('writes queued items to storage and empties the queue', async () => {
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    await enqueue(db, draft)
    const result = await flushOutbox({ db, storage })
    expect(result).toEqual({ sent: 1, failed: 0 })
    expect(fromUtf8(await storage.get(draft.path))).toBe('sealed')
    expect(await pending(db)).toHaveLength(0)
  })

  it('keeps items in the queue when the write fails', async () => {
    const db = openGroupDatabase('midori')
    await enqueue(db, draft)
    const result = await flushOutbox({ db, storage: offline() })
    expect(result).toEqual({ sent: 0, failed: 1 })
    expect(await pending(db)).toHaveLength(1)
  })

  it('counts an attempt on each failure', async () => {
    const db = openGroupDatabase('midori')
    await enqueue(db, draft)
    await flushOutbox({ db, storage: offline() })
    await flushOutbox({ db, storage: offline() })
    expect((await pending(db))[0]?.attempts).toBe(2)
  })

  it('sends the rest of the queue even when one item fails', async () => {
    const db = openGroupDatabase('midori')
    let first = true
    // 1件目だけ失敗し、2件目は成功する
    const flaky = withPut(() => {
      if (first) {
        first = false
        return Promise.reject(new Error('flaky'))
      }
      return Promise.resolve()
    })

    await enqueue(db, { ...draft, id: 'a', path: 'midori/events/a.enc' })
    await enqueue(db, { ...draft, id: 'b', path: 'midori/events/b.enc' })
    const result = await flushOutbox({ db, storage: flaky })
    expect(result).toEqual({ sent: 1, failed: 1 })
    expect(await pending(db)).toHaveLength(1)
  })

  it('sends the item on a later flush once the network is back', async () => {
    const db = openGroupDatabase('midori')
    const storage = new MemoryStorageProvider()
    await enqueue(db, draft)
    await flushOutbox({ db, storage: offline() })
    const result = await flushOutbox({ db, storage })
    expect(result).toEqual({ sent: 1, failed: 0 })
    expect(await pending(db)).toHaveLength(0)
  })

  it('reports an empty queue as nothing to do', async () => {
    const db = openGroupDatabase('midori')
    expect(await flushOutbox({ db, storage: new MemoryStorageProvider() })).toEqual({
      sent: 0,
      failed: 0,
    })
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/sync/outbox.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/sync/outbox"`

- [ ] **Step 3: 実装する**

`src/sync/outbox.ts`:

```ts
import type { GroupDatabase, OutboxItem } from '../db/group-db'
import type { StorageProvider } from '../storage/provider'

export interface FlushResult {
  sent: number
  failed: number
}

export async function enqueue(
  db: GroupDatabase,
  item: Omit<OutboxItem, 'queuedAt' | 'attempts'>,
): Promise<void> {
  await db.outbox.put({ ...item, queuedAt: new Date().toISOString(), attempts: 0 })
}

export async function pending(db: GroupDatabase): Promise<OutboxItem[]> {
  return db.outbox.orderBy('queuedAt').toArray()
}

/**
 * 溜まっている投稿をストレージへ送る。1件の失敗で以降を止めず、
 * 失敗した項目はキューに残して attempts を増やす(次回の再送で拾う)。
 */
export async function flushOutbox(options: {
  db: GroupDatabase
  storage: StorageProvider
}): Promise<FlushResult> {
  let sent = 0
  let failed = 0
  for (const item of await pending(options.db)) {
    try {
      await options.storage.put(item.path, item.body)
      await options.db.outbox.delete(item.id)
      sent += 1
    } catch {
      await options.db.outbox.put({ ...item, attempts: item.attempts + 1 })
      failed += 1
    }
  }
  return { sent, failed }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/sync/outbox.test.ts
```

Expected: 8 tests passed

- [ ] **Step 5: 全体の検証**

```bash
npm run test:run
npm run typecheck
npm run build
```

Expected: すべて成功。`npm run build` のバンドルサイズが Phase 1 (gzip 71.5 kB) から大きく増えていないことを確認する。増えていたら照合オラクルのパッケージが `src/` から import されている。

- [ ] **Step 6: コミット**

```bash
git add src/sync/outbox.ts tests/sync/outbox.test.ts
git commit -m "feat(sync): add offline outbox with retry-safe flushing"
```

---

## Phase 2a 完了条件

- `npm run test:run` が全て green
- `npm run typecheck` がエラーなし
- `npm run build` が成功し、配布バンドルに `@smithy/*` / `@aws-crypto/*` が含まれていない
- 署名の正しさが AWS 公式実装との一致で担保されている(捏造した期待値が1つも無い)

## 次フェーズへの引き継ぎ

Phase 2a で実装していない、Phase 2b 以降の作業:

- メッセージ・添付の投稿と閲覧(design 03/04/06)、`files/` の重複排除
- inbox の presigned URL 発行と配布、参加者からの投函(Task 3 の `presignUrl` が土台)
- 不在連絡(design 05)、メールアドレス必須フロー(design 02)
- mailto 通知(BCC・バッチ分割・テンプレート)
- 開設ウィザード・接続確認・リカバリキット(design 10)。接続確認は Task 5 と Task 6 を組み合わせて実装する
- `syncGroup` が適用したイベントから `messages` / `files` テーブルを更新する投影処理(現状はイベントの記録まで)

## 実装前に確認すること

- **§16-6 の検証課題(S3互換サービスの無料枠条件・カード要否・CORS 設定)は未了。** Task 5 までは実サービスなしで完了できるが、実バケットでの疎通確認をするなら先に決める必要がある。`S3ProviderConfig` はエンドポイントを設定値にしてあるので、サービス選定はコード変更を伴わない
- バケットに CORS 設定(`PUT` / `GET` / `HEAD` と `ETag` の公開)が要る(設計書 §7.4)。導入手順書に書く項目
