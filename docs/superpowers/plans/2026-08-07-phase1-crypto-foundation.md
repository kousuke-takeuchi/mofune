# Phase 1: 暗号基盤と認証 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> rev.2 (2026-08-07): デザイン確定を受けた仕様改訂に追従。汎用グループ化(admin / staff / member)、サブグループ木と所属の伝播、複数スコープ同時配信のためのマルチレシピエントエンベロープを反映済み。正は [要件書](../../Mofune%20-%20要件書.md) / [設計書](../../Mofune%20-%20設計書.md)。

**Goal:** 接続コード + ログインID + パスワードだけでグループにログインし、検証済みのスコープ鍵を保持できる状態にする。

**Architecture:** サーバーを持たないため「認証=復号」とする。公開ストレージ上のキーストアをパスワード由来鍵(Argon2id)で復号し、そこから得た個人ECDH秘密鍵でキーリングをアンラップしてグループ鍵を取り出す。名簿は管理者のECDSA鍵で署名され、信頼の根(管理者公開鍵)は紙で配る接続コードに埋め込む。ストレージはインターフェースで抽象化し、テストはインメモリ実装で完結させる。

**Tech Stack:** Vue 3 / TypeScript / Vite / Vitest / Dexie.js / Web Crypto API / hash-wasm (Argon2id)

## Global Constraints

- 依存バージョン: `vue ^3.5.41` / `vite ^8.2.1` / `vitest ^4.1.10` / `@vitejs/plugin-vue ^6.0.8` / `typescript ^5.9.3` / `vue-tsc ^3.3.9` / `dexie ^4.4.4` / `hash-wasm ^4.12.0` / `@vue/test-utils ^2.4.11` / `happy-dom ^20.11.1` / `fake-indexeddb ^6.2.5` / `@types/node ^26.1.2`
- 暗号プリミティブは Web Crypto API のみを使用する。例外は Argon2id (hash-wasm) のみ
- 曲線は P-256 固定。共通鍵は AES-256-GCM、IV は 12 バイト、署名は ECDSA/SHA-256
- 秘密鍵・パスワードを IndexedDB / localStorage に保存してはならない。セッションはメモリ上のみ
- `tsconfig.json` は `strict: true` と `verbatimModuleSyntax: true`。型のみの import は `import type` を使う
- テストは `tests/**/*.test.ts`。Vitest のグローバル API は使わず `import { describe, it, expect } from 'vitest'` を明示する
- 本番の KDF パラメータ (`PRODUCTION_KDF`) をテストで使わない。テストは必ず `TEST_KDF` を使う(本番パラメータは1回あたり数百ミリ秒かかるため)
- ログイン失敗時のエラーメッセージは、アカウント不存在とパスワード誤りで同一にする(アカウント列挙の防止)
- ロールは `admin` / `staff` / `member` の3種。UI表示は管理者 / 担当者 / 参加者。園・クラス・先生・保護者といった用途固有語をコードにもUIにも持ち込まない
- スコープ鍵はすべて独立に生成する。サブグループの親子関係から子の鍵を導出してはならない(設計書 §3.2)。所属の伝播は `resolveScopes` 1か所に閉じる
- 暗号化オブジェクトは必ずマルチレシピエントエンベロープ(`sealEnvelopeFor`)を通す。スコープ鍵で本文を直接暗号化しない
- テストで  とキャストしている箇所は  に読み替える( は )
- テストのコード例にある `as Uint8Array` というキャストは `as Bytes` に読み替え、`import type { Bytes } from '../../src/crypto/bytes'` を足す
- **バイト列の型は `src/crypto/bytes.ts` の `Bytes`(= `Uint8Array<ArrayBuffer>`)を使う。** TypeScript 5.7 以降 `Uint8Array` は `ArrayBufferLike` 既定になり、そのままでは WebCrypto の `BufferSource` に代入できず `vue-tsc` が落ちる。以降のタスクのコード例に出てくる型注釈上の `Uint8Array` はすべて `Bytes` と読み替える(`new Uint8Array(...)` という生成式はそのまま)
- コミットは Conventional Commits 形式。`Co-Authored-By` 行は付けない

## File Structure

```
package.json / vite.config.ts / tsconfig.json / index.html   Task 1
src/crypto/bytes.ts          バイト列とエンコーディングのユーティリティ   Task 2
src/crypto/symmetric.ts      乱数・SHA-256・AES-GCM                      Task 3
src/crypto/asymmetric.ts     ECDH/ECDSA の生成・入出力・署名検証          Task 4
src/crypto/envelope.ts       マルチレシピエント暗号文コンテナ             Task 5
src/crypto/kdf.ts            Argon2id による KEK 導出                     Task 6
src/crypto/keystore.ts       キーストアの作成と解錠                       Task 7
src/crypto/keyring.ts        ECIES 鍵ラップとキーリング                   Task 8
src/crypto/roster.ts         署名付き名簿・サブグループ木・スコープ解決    Task 9
src/group/connection-code.ts 接続コードの符号化・復号                     Task 10
src/group/manifest.ts        manifest.json の符号化・復号                 Task 10
src/storage/provider.ts      StorageProvider インターフェースと例外       Task 11
src/storage/paths.ts         ストレージレイアウトのパス生成               Task 11
src/storage/memory.ts        インメモリ実装(テスト・開発用)               Task 11
src/storage/http.ts          公開読み取り専用の HTTP 実装                 Task 12
src/group/provision.ts       グループ新規作成(Admin フロー)               Task 13
src/group/session.ts         ログイン処理                                 Task 14
src/db/groups.ts             既知グループのレジストリ(Dexie)              Task 15
src/ui/LoginView.vue         ログイン画面                                 Task 16
```

---

### Task 1: プロジェクト雛形とテスト基盤

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `.gitignore`
- Create: `src/main.ts`, `src/App.vue`, `src/vite-env.d.ts`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `npm run test:run` / `npm run typecheck` / `npm run dev` が動作する状態

このタスクの目的は、以降の全タスクが依存する前提(特にテスト環境で Web Crypto が使えること)を最初に実証することにある。

- [ ] **Step 1: `package.json` を作成する**

```json
{
  "name": "mofune",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest",
    "test:run": "vitest run",
    "typecheck": "vue-tsc --noEmit"
  },
  "dependencies": {
    "dexie": "^4.4.4",
    "hash-wasm": "^4.12.0",
    "vue": "^3.5.41"
  },
  "devDependencies": {
    "@types/node": "^26.1.2",
    "@vitejs/plugin-vue": "^6.0.8",
    "@vue/test-utils": "^2.4.11",
    "fake-indexeddb": "^6.2.5",
    "happy-dom": "^20.11.1",
    "typescript": "^5.9.3",
    "vite": "^8.2.1",
    "vitest": "^4.1.10",
    "vue-tsc": "^3.3.9"
  }
}
```

- [ ] **Step 2: 設定ファイル群を作成する**

`vite.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "jsx": "preserve"
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "tests/**/*.ts", "vite.config.ts"]
}
```

`.gitignore`:

```
node_modules/
dist/
.DS_Store
*.local
```

- [ ] **Step 3: 最小のアプリ骨格を作成する**

`index.html`:

```html
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mofune</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
```

`src/App.vue`:

```vue
<script setup lang="ts"></script>

<template>
  <main>
    <h1>Mofune</h1>
  </main>
</template>
```

`src/main.ts`:

```ts
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
```

- [ ] **Step 4: 失敗するスモークテストを書く**

`tests/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('toolchain', () => {
  it('exposes Web Crypto with SHA-256 in the test environment', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3]))
    expect(new Uint8Array(digest)).toHaveLength(32)
  })

  it('exposes crypto.getRandomValues', () => {
    const buf = new Uint8Array(16)
    crypto.getRandomValues(buf)
    expect(buf.some((byte) => byte !== 0)).toBe(true)
  })
})
```

- [ ] **Step 5: 依存をインストールしてテストを実行する**

```bash
npm install && npm run test:run
```

Expected: 2 tests passed。もし `crypto is not defined` で失敗する場合は Node.js のバージョンが古い(Node 20 以上が必要)。

- [ ] **Step 6: 型チェックを実行する**

```bash
npm run typecheck
```

Expected: エラーなしで終了。

- [ ] **Step 7: コミット**

```bash
git add package.json package-lock.json vite.config.ts tsconfig.json index.html .gitignore src tests
git commit -m "chore: scaffold Vite + Vue 3 + TypeScript + Vitest project"
```

---

### Task 2: バイト列ユーティリティ

**Files:**
- Create: `src/crypto/bytes.ts`
- Test: `tests/crypto/bytes.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `utf8(s: string): Uint8Array` / `fromUtf8(b: Uint8Array): string` / `toBase64(b: Uint8Array): string` / `fromBase64(s: string): Uint8Array` / `toBase64Url(b: Uint8Array): string` / `fromBase64Url(s: string): Uint8Array` / `toHex(b: Uint8Array): string` / `concat(...parts: Uint8Array[]): Uint8Array` / `equal(a: Uint8Array, b: Uint8Array): boolean`

- [ ] **Step 1: 失敗するテストを書く**

`tests/crypto/bytes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  utf8,
  fromUtf8,
  toBase64,
  fromBase64,
  toBase64Url,
  fromBase64Url,
  toHex,
  concat,
  equal,
} from '../../src/crypto/bytes'

describe('bytes', () => {
  it('round-trips UTF-8 including multibyte characters', () => {
    expect(fromUtf8(utf8('ひらがな漢字'))).toBe('ひらがな漢字')
  })

  it('round-trips base64 for arbitrary bytes', () => {
    const input = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255])
    expect(fromBase64(toBase64(input))).toEqual(input)
  })

  it('produces base64url without padding or unsafe characters', () => {
    const input = new Uint8Array([251, 255, 190, 255])
    const encoded = toBase64Url(input)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(fromBase64Url(encoded)).toEqual(input)
  })

  it('formats hex with zero padding', () => {
    expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe('000f10ff')
  })

  it('concatenates parts in order', () => {
    expect(concat(new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3]))).toEqual(
      new Uint8Array([1, 2, 3]),
    )
  })

  it('compares byte arrays by content', () => {
    expect(equal(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(equal(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(equal(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/crypto/bytes.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/crypto/bytes"`

- [ ] **Step 3: 実装する**

`src/crypto/bytes.ts`:

```ts
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number)
  }
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4))
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, '0')
  }
  return out
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** 長さが異なる場合は即座に false。同じ長さなら定数時間で比較する。 */
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number)
  }
  return diff === 0
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/crypto/bytes.test.ts
```

Expected: 6 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/crypto/bytes.ts tests/crypto/bytes.test.ts
git commit -m "feat(crypto): add byte and encoding utilities"
```

---

### Task 3: 共通鍵プリミティブ

**Files:**
- Create: `src/crypto/symmetric.ts`
- Test: `tests/crypto/symmetric.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: 定数 `AES_KEY_BYTES = 32` / `IV_BYTES = 12`、`randomBytes(length: number): Uint8Array` / `sha256(data: Uint8Array): Promise<Uint8Array>` / `generateAesKey(): Promise<CryptoKey>` / `importAesKey(raw: Uint8Array): Promise<CryptoKey>` / `exportAesKey(key: CryptoKey): Promise<Uint8Array>` / `aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array, iv: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>` / `aesGcmDecrypt(key: CryptoKey, ciphertext: Uint8Array, iv: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/crypto/symmetric.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  AES_KEY_BYTES,
  IV_BYTES,
  randomBytes,
  sha256,
  generateAesKey,
  importAesKey,
  exportAesKey,
  aesGcmEncrypt,
  aesGcmDecrypt,
} from '../../src/crypto/symmetric'
import { utf8, toHex } from '../../src/crypto/bytes'

describe('symmetric', () => {
  it('generates random bytes of the requested length', () => {
    expect(randomBytes(24)).toHaveLength(24)
    expect(toHex(randomBytes(16))).not.toBe(toHex(randomBytes(16)))
  })

  it('computes the known SHA-256 digest of "abc"', async () => {
    expect(toHex(await sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('exports a generated AES key as 32 bytes', async () => {
    expect(await exportAesKey(await generateAesKey())).toHaveLength(AES_KEY_BYTES)
  })

  it('round-trips a message through AES-GCM', async () => {
    const key = await generateAesKey()
    const iv = randomBytes(IV_BYTES)
    const plaintext = utf8('欠席連絡です')
    const ciphertext = await aesGcmEncrypt(key, plaintext, iv)
    expect(ciphertext).not.toEqual(plaintext)
    expect(await aesGcmDecrypt(key, ciphertext, iv)).toEqual(plaintext)
  })

  it('binds additional authenticated data', async () => {
    const key = await generateAesKey()
    const iv = randomBytes(IV_BYTES)
    const ciphertext = await aesGcmEncrypt(key, utf8('body'), iv, utf8('header'))
    await expect(aesGcmDecrypt(key, ciphertext, iv, utf8('tampered'))).rejects.toThrow()
  })

  it('fails to decrypt with the wrong key', async () => {
    const iv = randomBytes(IV_BYTES)
    const ciphertext = await aesGcmEncrypt(await generateAesKey(), utf8('body'), iv)
    await expect(aesGcmDecrypt(await generateAesKey(), ciphertext, iv)).rejects.toThrow()
  })

  it('imports a raw key that decrypts what the exported key encrypted', async () => {
    const key = await generateAesKey()
    const iv = randomBytes(IV_BYTES)
    const ciphertext = await aesGcmEncrypt(key, utf8('body'), iv)
    const reimported = await importAesKey(await exportAesKey(key))
    expect(await aesGcmDecrypt(reimported, ciphertext, iv)).toEqual(utf8('body'))
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/crypto/symmetric.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/crypto/symmetric"`

- [ ] **Step 3: 実装する**

`src/crypto/symmetric.ts`:

```ts
export const AES_KEY_BYTES = 32
export const IV_BYTES = 12

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

export async function generateAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
}

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== AES_KEY_BYTES) {
    throw new Error(`AES key must be ${AES_KEY_BYTES} bytes, got ${raw.length}`)
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
}

export async function exportAesKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key))
}

function gcmParams(iv: Uint8Array, aad?: Uint8Array): AesGcmParams {
  if (iv.length !== IV_BYTES) {
    throw new Error(`AES-GCM IV must be ${IV_BYTES} bytes, got ${iv.length}`)
  }
  return aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv }
}

export async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  iv: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.encrypt(gcmParams(iv, aad), key, plaintext))
}

export async function aesGcmDecrypt(
  key: CryptoKey,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt(gcmParams(iv, aad), key, ciphertext))
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/crypto/symmetric.test.ts
```

Expected: 7 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/crypto/symmetric.ts tests/crypto/symmetric.test.ts
git commit -m "feat(crypto): add AES-GCM, SHA-256 and CSPRNG primitives"
```

---

### Task 4: 公開鍵プリミティブ

**Files:**
- Create: `src/crypto/asymmetric.ts`
- Test: `tests/crypto/asymmetric.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `interface RawKeyPair { publicKey: Uint8Array; privateKey: Uint8Array }`(公開鍵は raw 65 バイト、秘密鍵は PKCS#8)、`generateEcdhKeyPair(): Promise<RawKeyPair>` / `generateEcdsaKeyPair(): Promise<RawKeyPair>` / `importEcdhPublicKey(raw: Uint8Array): Promise<CryptoKey>` / `importEcdhPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey>` / `sign(pkcs8: Uint8Array, data: Uint8Array): Promise<Uint8Array>` / `verify(rawPublicKey: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean>`

秘密鍵を `CryptoKey` ではなく PKCS#8 バイト列で扱うのは、キーストアに格納してシリアライズする必要があるため。

- [ ] **Step 1: 失敗するテストを書く**

`tests/crypto/asymmetric.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  generateEcdhKeyPair,
  generateEcdsaKeyPair,
  importEcdhPublicKey,
  importEcdhPrivateKey,
  sign,
  verify,
} from '../../src/crypto/asymmetric'
import { utf8 } from '../../src/crypto/bytes'

describe('asymmetric', () => {
  it('generates an ECDH pair with a 65-byte uncompressed public point', async () => {
    const pair = await generateEcdhKeyPair()
    expect(pair.publicKey).toHaveLength(65)
    expect(pair.publicKey[0]).toBe(0x04)
    expect(pair.privateKey.length).toBeGreaterThan(0)
  })

  it('imports both halves of an ECDH pair', async () => {
    const pair = await generateEcdhKeyPair()
    await expect(importEcdhPublicKey(pair.publicKey)).resolves.toBeDefined()
    await expect(importEcdhPrivateKey(pair.privateKey)).resolves.toBeDefined()
  })

  it('derives the same ECDH shared secret from both sides', async () => {
    const alice = await generateEcdhKeyPair()
    const bob = await generateEcdhKeyPair()
    const fromAlice = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importEcdhPublicKey(bob.publicKey) },
      await importEcdhPrivateKey(alice.privateKey),
      256,
    )
    const fromBob = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importEcdhPublicKey(alice.publicKey) },
      await importEcdhPrivateKey(bob.privateKey),
      256,
    )
    expect(new Uint8Array(fromAlice)).toEqual(new Uint8Array(fromBob))
  })

  it('signs and verifies a message', async () => {
    const pair = await generateEcdsaKeyPair()
    const message = utf8('roster contents')
    const signature = await sign(pair.privateKey, message)
    expect(await verify(pair.publicKey, signature, message)).toBe(true)
  })

  it('rejects a signature over different data', async () => {
    const pair = await generateEcdsaKeyPair()
    const signature = await sign(pair.privateKey, utf8('original'))
    expect(await verify(pair.publicKey, signature, utf8('tampered'))).toBe(false)
  })

  it('rejects a signature from a different key', async () => {
    const signer = await generateEcdsaKeyPair()
    const other = await generateEcdsaKeyPair()
    const message = utf8('roster contents')
    const signature = await sign(signer.privateKey, message)
    expect(await verify(other.publicKey, signature, message)).toBe(false)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/crypto/asymmetric.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/crypto/asymmetric"`

- [ ] **Step 3: 実装する**

`src/crypto/asymmetric.ts`:

```ts
const ECDH_ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' } as const
const ECDSA_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const
const ECDSA_SIGNATURE = { name: 'ECDSA', hash: 'SHA-256' } as const

export interface RawKeyPair {
  /** raw uncompressed point, 65 bytes */
  publicKey: Uint8Array
  /** PKCS#8 */
  privateKey: Uint8Array
}

async function generatePair(
  algorithm: EcKeyGenParams,
  usages: KeyUsage[],
): Promise<RawKeyPair> {
  const pair = (await crypto.subtle.generateKey(algorithm, true, usages)) as CryptoKeyPair
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  }
}

export async function generateEcdhKeyPair(): Promise<RawKeyPair> {
  return generatePair(ECDH_ALGORITHM, ['deriveBits'])
}

export async function generateEcdsaKeyPair(): Promise<RawKeyPair> {
  return generatePair(ECDSA_ALGORITHM, ['sign', 'verify'])
}

export async function importEcdhPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, ECDH_ALGORITHM, false, [])
}

export async function importEcdhPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, ECDH_ALGORITHM, false, ['deriveBits'])
}

export async function importEcdsaPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, ECDSA_ALGORITHM, false, ['verify'])
}

export async function importEcdsaPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, ECDSA_ALGORITHM, false, ['sign'])
}

export async function sign(pkcs8: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await importEcdsaPrivateKey(pkcs8)
  return new Uint8Array(await crypto.subtle.sign(ECDSA_SIGNATURE, key, data))
}

export async function verify(
  rawPublicKey: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  let key: CryptoKey
  try {
    key = await importEcdsaPublicKey(rawPublicKey)
  } catch {
    return false
  }
  return crypto.subtle.verify(ECDSA_SIGNATURE, key, signature, data)
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/crypto/asymmetric.test.ts
```

Expected: 6 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/crypto/asymmetric.ts tests/crypto/asymmetric.test.ts
git commit -m "feat(crypto): add P-256 ECDH and ECDSA primitives"
```

---

### Task 5: エンベロープ形式(マルチレシピエント)

**Files:**
- Create: `src/crypto/envelope.ts`
- Test: `tests/crypto/envelope.test.ts`

**Interfaces:**
- Consumes: Task 2 の `concat` / `equal` / `utf8` / `fromUtf8`、Task 3 の `IV_BYTES` / `randomBytes` / `aesGcmEncrypt` / `aesGcmDecrypt` / `generateAesKey` / `exportAesKey` / `importAesKey`
- Produces: `class EnvelopeError extends Error` / `class DecryptionError extends Error`、`interface EnvelopeRecipient { keyId: string; wrapped: Uint8Array }`、`interface ParsedEnvelope { recipients: EnvelopeRecipient[]; iv: Uint8Array; ciphertext: Uint8Array; header: Uint8Array }`、`interface SealTarget { keyId: string; key: CryptoKey }`、`parseEnvelope(bytes: Uint8Array): ParsedEnvelope` / `readKeyIds(bytes: Uint8Array): string[]` / `sealEnvelopeFor(targets: SealTarget[], plaintext: Uint8Array): Promise<Uint8Array>` / `sealEnvelope(key: CryptoKey, keyId: string, plaintext: Uint8Array): Promise<Uint8Array>` / `openEnvelope(keys: ReadonlyMap<string, CryptoKey>, bytes: Uint8Array): Promise<Uint8Array>` / `openEnvelopeWithKey(key: CryptoKey, bytes: Uint8Array): Promise<Uint8Array>`

1つのメッセージを複数スコープへ同時配信する(設計書 §3.3 / design 06「届ける相手: Aチーム + 送迎係」)。そのため本体はスコープ鍵で直接暗号化せず、オブジェクトごとにランダムなコンテンツ鍵 (CEK) を作り、**宛先スコープの数だけ CEK をラップして並べる**。

バイナリ形式(全てビッグエンディアン、固定順):

```
offset 0 : magic "MFN1"                         (4 bytes)
offset 4 : version = 2                          (1 byte)
offset 5 : recipient count R (1-255)            (1 byte)
R 回繰り返し:
           keyId 長 (1 byte, 1-255)
           keyId (UTF-8)
           wrapped 長 (1 byte) = 60
           wrapped = IV(12) || AES-GCM(scopeKey, CEK 32B, AAD=keyId)
その後   : body IV (12 bytes)
その後   : ciphertext = AES-GCM(CEK, plaintext, AAD=先頭からbody IVまでの全ヘッダ)
```

- `keyId` を平文で置くのは、鍵を持たない段階で「自分に開けるか」を判別する必要があるため
- ヘッダ全体(宛先リストを含む)を本体の AAD にするので、宛先の差し替え・追加・削除は復号失敗として検出される
- CEK のラップにも `keyId` を AAD として与え、別スコープのエントリを付け替えられないようにする
- 単一スコープのオブジェクト(キーストア・設定・名簿の staff 部)は R=1 の特殊ケース。`sealEnvelope` / `openEnvelopeWithKey` がその薄いラッパ

- [ ] **Step 1: 失敗するテストを書く**

`tests/crypto/envelope.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  EnvelopeError,
  DecryptionError,
  parseEnvelope,
  readKeyIds,
  sealEnvelope,
  sealEnvelopeFor,
  openEnvelope,
  openEnvelopeWithKey,
} from '../../src/crypto/envelope'
import { generateAesKey } from '../../src/crypto/symmetric'
import { utf8 } from '../../src/crypto/bytes'

const headerLength = (keyIds: string[]): number =>
  4 + 1 + 1 + keyIds.reduce((sum, id) => sum + 1 + utf8(id).length + 1 + 60, 0) + 12

describe('envelope', () => {
  it('round-trips a plaintext for a single recipient', async () => {
    const key = await generateAesKey()
    const sealed = await sealEnvelope(key, 'sg_a:v1', utf8('おしらせ本文'))
    expect(await openEnvelopeWithKey(key, sealed)).toEqual(utf8('おしらせ本文'))
  })

  it('opens with any one of the addressed scope keys', async () => {
    const teamKey = await generateAesKey()
    const pickupKey = await generateAesKey()
    const sealed = await sealEnvelopeFor(
      [
        { keyId: 'sg_a:v1', key: teamKey },
        { keyId: 'sg_a_pickup:v1', key: pickupKey },
      ],
      utf8('来週の集まりについて'),
    )
    const holdsTeam = new Map([['sg_a:v1', teamKey]])
    const holdsPickup = new Map([['sg_a_pickup:v1', pickupKey]])
    expect(await openEnvelope(holdsTeam, sealed)).toEqual(utf8('来週の集まりについて'))
    expect(await openEnvelope(holdsPickup, sealed)).toEqual(utf8('来週の集まりについて'))
  })

  it('exposes the key ids without holding any key', async () => {
    const sealed = await sealEnvelopeFor(
      [
        { keyId: 'all:v3', key: await generateAesKey() },
        { keyId: 'staff:v3', key: await generateAesKey() },
      ],
      utf8('body'),
    )
    expect(readKeyIds(sealed)).toEqual(['all:v3', 'staff:v3'])
  })

  it('parses the structural fields', async () => {
    const sealed = await sealEnvelopeFor(
      [
        { keyId: 'all:v1', key: await generateAesKey() },
        { keyId: 'sg_a:v1', key: await generateAesKey() },
      ],
      utf8('body'),
    )
    const parsed = parseEnvelope(sealed)
    expect(parsed.recipients.map((r) => r.keyId)).toEqual(['all:v1', 'sg_a:v1'])
    expect(parsed.recipients[0]?.wrapped).toHaveLength(60)
    expect(parsed.iv).toHaveLength(12)
    expect(parsed.header).toHaveLength(headerLength(['all:v1', 'sg_a:v1']))
    expect(parsed.ciphertext.length).toBeGreaterThan(0)
  })

  it('uses a fresh content key for every seal', async () => {
    const key = await generateAesKey()
    const a = await sealEnvelope(key, 'all:v1', utf8('body'))
    const b = await sealEnvelope(key, 'all:v1', utf8('body'))
    expect(parseEnvelope(a).ciphertext).not.toEqual(parseEnvelope(b).ciphertext)
    expect(parseEnvelope(a).recipients[0]?.wrapped).not.toEqual(
      parseEnvelope(b).recipients[0]?.wrapped,
    )
  })

  it('rejects bytes without the magic prefix', () => {
    expect(() => parseEnvelope(new Uint8Array(120))).toThrow(EnvelopeError)
  })

  it('rejects a truncated envelope', async () => {
    const sealed = await sealEnvelope(await generateAesKey(), 'all:v1', utf8('body'))
    expect(() => parseEnvelope(sealed.subarray(0, 20))).toThrow(EnvelopeError)
  })

  it('rejects an empty recipient list', async () => {
    await expect(sealEnvelopeFor([], utf8('body'))).rejects.toThrow(EnvelopeError)
  })

  it('rejects an empty key id', async () => {
    await expect(sealEnvelope(await generateAesKey(), '', utf8('body'))).rejects.toThrow(
      EnvelopeError,
    )
  })

  it('rejects duplicate key ids', async () => {
    const key = await generateAesKey()
    await expect(
      sealEnvelopeFor([{ keyId: 'all:v1', key }, { keyId: 'all:v1', key }], utf8('body')),
    ).rejects.toThrow(EnvelopeError)
  })

  it('detects tampering with the plaintext key id header', async () => {
    const key = await generateAesKey()
    const sealed = await sealEnvelope(key, 'all:v1', utf8('body'))
    // 先頭 recipient の keyId 1 バイト目を書き換える
    sealed[7] = sealed[7] === 0x61 ? 0x62 : 0x61
    await expect(openEnvelopeWithKey(key, sealed)).rejects.toThrow(DecryptionError)
  })

  it('fails when the caller holds none of the addressed keys', async () => {
    const sealed = await sealEnvelope(await generateAesKey(), 'all:v1', utf8('body'))
    const stranger = new Map([['sg_a:v1', await generateAesKey()]])
    await expect(openEnvelope(stranger, sealed)).rejects.toThrow(DecryptionError)
  })

  it('fails when the held key id matches but the key is wrong', async () => {
    const sealed = await sealEnvelope(await generateAesKey(), 'all:v1', utf8('body'))
    const wrong = new Map([['all:v1', await generateAesKey()]])
    await expect(openEnvelope(wrong, sealed)).rejects.toThrow(DecryptionError)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/crypto/envelope.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/crypto/envelope"`

- [ ] **Step 3: 実装する**

`src/crypto/envelope.ts`:

```ts
import { concat, equal, fromUtf8, utf8 } from './bytes'
import {
  IV_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  exportAesKey,
  generateAesKey,
  importAesKey,
  randomBytes,
} from './symmetric'

export class EnvelopeError extends Error {}
export class DecryptionError extends Error {}

export const ENVELOPE_MAGIC = utf8('MFN1')
export const ENVELOPE_VERSION = 2

const MAGIC_LENGTH = 4
/** magic + version + recipient count */
const RECIPIENTS_OFFSET = MAGIC_LENGTH + 2
/** IV(12) + AES-GCM(CEK 32B) の暗号文 32 + 認証タグ 16 */
const WRAPPED_LENGTH = IV_BYTES + 32 + 16

export interface EnvelopeRecipient {
  keyId: string
  /** IV(12) || AES-GCM(scopeKey, CEK, AAD=keyId) */
  wrapped: Uint8Array
}

export interface ParsedEnvelope {
  recipients: EnvelopeRecipient[]
  iv: Uint8Array
  ciphertext: Uint8Array
  /** magic から body IV までの平文ヘッダ。本体の AAD として使う。 */
  header: Uint8Array
}

export interface SealTarget {
  keyId: string
  key: CryptoKey
}

async function wrapContentKey(target: SealTarget, cek: CryptoKey): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES)
  const sealed = await aesGcmEncrypt(target.key, await exportAesKey(cek), iv, utf8(target.keyId))
  return concat(iv, sealed)
}

async function unwrapContentKey(
  recipient: EnvelopeRecipient,
  scopeKey: CryptoKey,
): Promise<CryptoKey> {
  const raw = await aesGcmDecrypt(
    scopeKey,
    recipient.wrapped.subarray(IV_BYTES),
    recipient.wrapped.subarray(0, IV_BYTES),
    utf8(recipient.keyId),
  )
  return importAesKey(raw)
}

export function parseEnvelope(bytes: Uint8Array): ParsedEnvelope {
  if (bytes.length < RECIPIENTS_OFFSET) {
    throw new EnvelopeError('envelope is too short')
  }
  if (!equal(bytes.subarray(0, MAGIC_LENGTH), ENVELOPE_MAGIC)) {
    throw new EnvelopeError('envelope magic does not match')
  }
  const version = bytes[MAGIC_LENGTH] as number
  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeError(`unsupported envelope version ${version}`)
  }
  const count = bytes[MAGIC_LENGTH + 1] as number
  if (count === 0) {
    throw new EnvelopeError('envelope has no recipients')
  }

  const recipients: EnvelopeRecipient[] = []
  let offset = RECIPIENTS_OFFSET
  for (let i = 0; i < count; i += 1) {
    if (offset >= bytes.length) throw new EnvelopeError('envelope is truncated')
    const keyIdLength = bytes[offset] as number
    if (keyIdLength === 0) throw new EnvelopeError('envelope has an empty keyId')
    offset += 1
    const keyIdEnd = offset + keyIdLength
    if (keyIdEnd >= bytes.length) throw new EnvelopeError('envelope is truncated')
    const keyId = fromUtf8(bytes.subarray(offset, keyIdEnd))
    const wrappedLength = bytes[keyIdEnd] as number
    if (wrappedLength !== WRAPPED_LENGTH) {
      throw new EnvelopeError(`wrapped key must be ${WRAPPED_LENGTH} bytes, got ${wrappedLength}`)
    }
    const wrappedEnd = keyIdEnd + 1 + wrappedLength
    if (wrappedEnd > bytes.length) throw new EnvelopeError('envelope is truncated')
    recipients.push({ keyId, wrapped: bytes.subarray(keyIdEnd + 1, wrappedEnd) })
    offset = wrappedEnd
  }

  const ivEnd = offset + IV_BYTES
  if (bytes.length <= ivEnd) {
    throw new EnvelopeError('envelope is truncated')
  }
  return {
    recipients,
    iv: bytes.subarray(offset, ivEnd),
    ciphertext: bytes.subarray(ivEnd),
    header: bytes.subarray(0, ivEnd),
  }
}

export function readKeyIds(bytes: Uint8Array): string[] {
  return parseEnvelope(bytes).recipients.map((recipient) => recipient.keyId)
}

export async function sealEnvelopeFor(
  targets: SealTarget[],
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (targets.length < 1 || targets.length > 255) {
    throw new EnvelopeError(`envelope needs 1-255 recipients, got ${targets.length}`)
  }
  const keyIds = new Set(targets.map((target) => target.keyId))
  if (keyIds.size !== targets.length) {
    throw new EnvelopeError('envelope recipients must have distinct keyIds')
  }

  const cek = await generateAesKey()
  const parts: Uint8Array[] = [ENVELOPE_MAGIC, new Uint8Array([ENVELOPE_VERSION, targets.length])]
  for (const target of targets) {
    const encodedKeyId = utf8(target.keyId)
    if (encodedKeyId.length < 1 || encodedKeyId.length > 255) {
      throw new EnvelopeError(
        `keyId must encode to 1-255 bytes, got ${encodedKeyId.length}`,
      )
    }
    const wrapped = await wrapContentKey(target, cek)
    parts.push(
      new Uint8Array([encodedKeyId.length]),
      encodedKeyId,
      new Uint8Array([wrapped.length]),
      wrapped,
    )
  }
  parts.push(randomBytes(IV_BYTES))

  const header = concat(...parts)
  const iv = header.subarray(header.length - IV_BYTES)
  return concat(header, await aesGcmEncrypt(cek, plaintext, iv, header))
}

export async function sealEnvelope(
  key: CryptoKey,
  keyId: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  return sealEnvelopeFor([{ keyId, key }], plaintext)
}

export async function openEnvelope(
  keys: ReadonlyMap<string, CryptoKey>,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const envelope = parseEnvelope(bytes)
  for (const recipient of envelope.recipients) {
    const scopeKey = keys.get(recipient.keyId)
    if (!scopeKey) continue
    try {
      const cek = await unwrapContentKey(recipient, scopeKey)
      return await aesGcmDecrypt(cek, envelope.ciphertext, envelope.iv, envelope.header)
    } catch {
      // この鍵では開けない。次の宛先を試す。
    }
  }
  throw new DecryptionError(
    `no held key could open this envelope (addressed to ${envelope.recipients
      .map((recipient) => recipient.keyId)
      .join(', ')})`,
  )
}

/** 単一スコープのオブジェクト用。keyId を問わず手持ちの鍵で総当たりする。 */
export async function openEnvelopeWithKey(
  key: CryptoKey,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const envelope = parseEnvelope(bytes)
  const keys = new Map(envelope.recipients.map((recipient) => [recipient.keyId, key]))
  return openEnvelope(keys, bytes)
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/crypto/envelope.test.ts
```

Expected: 13 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/crypto/envelope.ts tests/crypto/envelope.test.ts
git commit -m "feat(crypto): add multi-recipient authenticated envelope format"
```

---

### Task 6: パスワード由来鍵の導出

**Files:**
- Create: `src/crypto/kdf.ts`
- Test: `tests/crypto/kdf.test.ts`

**Interfaces:**
- Consumes: Task 2 の `utf8`、Task 3 の `importAesKey`
- Produces: `interface KdfParams { algorithm: 'argon2id'; iterations: number; memorySize: number; parallelism: number; hashLength: number }`、定数 `PRODUCTION_KDF` / `TEST_KDF` / `SALT_BYTES = 16`、`deriveKek(password: string, pepper: string, salt: Uint8Array, params: KdfParams): Promise<CryptoKey>`

ペッパーは接続コードにのみ載る園ごとの秘密値で、ストレージには置かない。公開ストレージ上のキーストアを入手しただけではオフライン総当たりを開始できないようにするための第2要素。パスワードとペッパーは、パスワード長のプレフィックスを付けて連結してから Argon2id に渡す(境界を動かした別の組み合わせが同じ導出結果にならないようにするため)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/crypto/kdf.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PRODUCTION_KDF, TEST_KDF, SALT_BYTES, deriveKek } from '../../src/crypto/kdf'
import { exportAesKey, randomBytes } from '../../src/crypto/symmetric'
import { toHex } from '../../src/crypto/bytes'

const salt = randomBytes(SALT_BYTES)

describe('kdf', () => {
  it('derives a 32-byte AES key', async () => {
    const key = await deriveKek('correct horse', 'pepper', salt, TEST_KDF)
    expect(await exportAesKey(key)).toHaveLength(32)
  })

  it('is deterministic for the same inputs', async () => {
    const a = await deriveKek('pass', 'pepper', salt, TEST_KDF)
    const b = await deriveKek('pass', 'pepper', salt, TEST_KDF)
    expect(toHex(await exportAesKey(a))).toBe(toHex(await exportAesKey(b)))
  })

  it('produces a different key for a different password', async () => {
    const a = await deriveKek('pass', 'pepper', salt, TEST_KDF)
    const b = await deriveKek('Pass', 'pepper', salt, TEST_KDF)
    expect(toHex(await exportAesKey(a))).not.toBe(toHex(await exportAesKey(b)))
  })

  it('produces a different key for a different pepper', async () => {
    const a = await deriveKek('pass', 'pepper-a', salt, TEST_KDF)
    const b = await deriveKek('pass', 'pepper-b', salt, TEST_KDF)
    expect(toHex(await exportAesKey(a))).not.toBe(toHex(await exportAesKey(b)))
  })

  it('produces a different key for a different salt', async () => {
    const a = await deriveKek('pass', 'pepper', randomBytes(SALT_BYTES), TEST_KDF)
    const b = await deriveKek('pass', 'pepper', randomBytes(SALT_BYTES), TEST_KDF)
    expect(toHex(await exportAesKey(a))).not.toBe(toHex(await exportAesKey(b)))
  })

  it('cannot be fooled by moving the boundary between password and pepper', async () => {
    const a = await deriveKek('ab', 'c', salt, TEST_KDF)
    const b = await deriveKek('a', 'bc', salt, TEST_KDF)
    expect(toHex(await exportAesKey(a))).not.toBe(toHex(await exportAesKey(b)))
  })

  it('rejects a salt shorter than 8 bytes', async () => {
    await expect(deriveKek('pass', 'pepper', randomBytes(4), TEST_KDF)).rejects.toThrow(
      /salt/,
    )
  })

  it('uses at least 64 MiB of memory in production parameters', () => {
    expect(PRODUCTION_KDF.memorySize).toBeGreaterThanOrEqual(65536)
    expect(PRODUCTION_KDF.algorithm).toBe('argon2id')
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/crypto/kdf.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/crypto/kdf"`

- [ ] **Step 3: 実装する**

`src/crypto/kdf.ts`:

```ts
import { argon2id } from 'hash-wasm'
import { utf8 } from './bytes'
import { importAesKey } from './symmetric'

export const SALT_BYTES = 16

export interface KdfParams {
  algorithm: 'argon2id'
  /** 反復回数 (Argon2 の t) */
  iterations: number
  /** メモリ使用量 (KiB, Argon2 の m) */
  memorySize: number
  /** 並列度 (Argon2 の p) */
  parallelism: number
  hashLength: number
}

/** 本番用。モバイル実機での所要時間は設計書 §14 の検証課題。 */
export const PRODUCTION_KDF: KdfParams = {
  algorithm: 'argon2id',
  iterations: 3,
  memorySize: 65536,
  parallelism: 1,
  hashLength: 32,
}

/** テスト専用。総当たり耐性は無い。 */
export const TEST_KDF: KdfParams = {
  algorithm: 'argon2id',
  iterations: 1,
  memorySize: 1024,
  parallelism: 1,
  hashLength: 32,
}

export async function deriveKek(
  password: string,
  pepper: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<CryptoKey> {
  if (params.algorithm !== 'argon2id') {
    throw new Error(`unsupported KDF algorithm: ${String(params.algorithm)}`)
  }
  if (salt.length < 8) {
    throw new Error(`salt must be at least 8 bytes, got ${salt.length}`)
  }
  // 長さプレフィックスで連結し、境界を動かした別の組み合わせが
  // 同じ入力にならないようにする("ab"+"c" と "a"+"bc" を区別する)
  const secret = utf8(`${password.length}:${password}${pepper}`)
  const raw = (await argon2id({
    password: secret,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memorySize,
    hashLength: params.hashLength,
    outputType: 'binary',
  })) as Uint8Array
  return importAesKey(raw)
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/crypto/kdf.test.ts
```

Expected: 8 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/crypto/kdf.ts tests/crypto/kdf.test.ts
git commit -m "feat(crypto): derive key-encryption keys with Argon2id and a pepper"
```

---

### Task 7: キーストア

**Files:**
- Create: `src/crypto/keystore.ts`
- Test: `tests/crypto/keystore.test.ts`

**Interfaces:**
- Consumes: Task 2 の `toBase64` / `fromBase64` / `utf8` / `fromUtf8`、Task 3 の `randomBytes`、Task 4 の `RawKeyPair`、Task 5 の `sealEnvelope` / `openEnvelope` / `DecryptionError`、Task 6 の `KdfParams` / `PRODUCTION_KDF` / `SALT_BYTES` / `deriveKek`
- Produces: `class InvalidPasswordError extends Error`、`interface KeystoreContents { userId: string; ecdh: RawKeyPair; ecdsa: RawKeyPair }`、`interface KeystoreFile`、`createKeystore(contents: KeystoreContents, password: string, pepper: string, params?: KdfParams): Promise<KeystoreFile>` / `unlockKeystore(file: KeystoreFile, password: string, pepper: string): Promise<KeystoreContents>` / `parseKeystoreFile(bytes: Uint8Array): KeystoreFile` / `serializeKeystoreFile(file: KeystoreFile): Uint8Array`

キーストアは JSON として保存する。KDF パラメータをファイル内に持たせることで、将来パラメータを強化しても既存ファイルを解錠できる。

- [ ] **Step 1: 失敗するテストを書く**

`tests/crypto/keystore.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  InvalidPasswordError,
  createKeystore,
  unlockKeystore,
  parseKeystoreFile,
  serializeKeystoreFile,
} from '../../src/crypto/keystore'
import type { KeystoreContents } from '../../src/crypto/keystore'
import { generateEcdhKeyPair, generateEcdsaKeyPair } from '../../src/crypto/asymmetric'
import { TEST_KDF } from '../../src/crypto/kdf'
import { toHex } from '../../src/crypto/bytes'

async function sampleContents(): Promise<KeystoreContents> {
  return {
    userId: 'u_0123456789abcdef',
    ecdh: await generateEcdhKeyPair(),
    ecdsa: await generateEcdsaKeyPair(),
  }
}

describe('keystore', () => {
  it('round-trips the contents with the correct password', async () => {
    const contents = await sampleContents()
    const file = await createKeystore(contents, 'tulip-anchor-mellow-drift', 'pep', TEST_KDF)
    const unlocked = await unlockKeystore(file, 'tulip-anchor-mellow-drift', 'pep')
    expect(unlocked.userId).toBe(contents.userId)
    expect(toHex(unlocked.ecdh.privateKey)).toBe(toHex(contents.ecdh.privateKey))
    expect(toHex(unlocked.ecdh.publicKey)).toBe(toHex(contents.ecdh.publicKey))
    expect(toHex(unlocked.ecdsa.privateKey)).toBe(toHex(contents.ecdsa.privateKey))
  })

  it('rejects a wrong password', async () => {
    const file = await createKeystore(await sampleContents(), 'right', 'pep', TEST_KDF)
    await expect(unlockKeystore(file, 'wrong', 'pep')).rejects.toThrow(InvalidPasswordError)
  })

  it('rejects a wrong pepper', async () => {
    const file = await createKeystore(await sampleContents(), 'right', 'pep', TEST_KDF)
    await expect(unlockKeystore(file, 'right', 'other')).rejects.toThrow(InvalidPasswordError)
  })

  it('stores the KDF parameters and a fresh salt in the file', async () => {
    const a = await createKeystore(await sampleContents(), 'pass', 'pep', TEST_KDF)
    const b = await createKeystore(await sampleContents(), 'pass', 'pep', TEST_KDF)
    expect(a.kdf.iterations).toBe(TEST_KDF.iterations)
    expect(a.kdf.memorySize).toBe(TEST_KDF.memorySize)
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
  })

  it('does not leak the private key or user id into the serialized form', async () => {
    const contents = await sampleContents()
    const file = await createKeystore(contents, 'pass', 'pep', TEST_KDF)
    const text = new TextDecoder().decode(serializeKeystoreFile(file))
    expect(text).not.toContain(toHex(contents.ecdh.privateKey))
    expect(text).not.toContain(contents.userId)
  })

  it('survives a serialize/parse round trip', async () => {
    const contents = await sampleContents()
    const file = await createKeystore(contents, 'pass', 'pep', TEST_KDF)
    const reparsed = parseKeystoreFile(serializeKeystoreFile(file))
    const unlocked = await unlockKeystore(reparsed, 'pass', 'pep')
    expect(unlocked.userId).toBe(contents.userId)
  })

  it('rejects a file with an unknown version', async () => {
    const file = await createKeystore(await sampleContents(), 'pass', 'pep', TEST_KDF)
    const broken = JSON.stringify({ ...file, v: 99 })
    expect(() => parseKeystoreFile(new TextEncoder().encode(broken))).toThrow(/version/)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/crypto/keystore.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/crypto/keystore"`

- [ ] **Step 3: 実装する**

`src/crypto/keystore.ts`:

```ts
import type { RawKeyPair } from './asymmetric'
import { fromBase64, fromUtf8, toBase64, utf8 } from './bytes'
import { DecryptionError, openEnvelopeWithKey, sealEnvelope } from './envelope'
import type { KdfParams } from './kdf'
import { PRODUCTION_KDF, SALT_BYTES, deriveKek } from './kdf'
import { randomBytes } from './symmetric'

export class InvalidPasswordError extends Error {}
export class KeystoreFormatError extends Error {}

export const KEYSTORE_VERSION = 1
export const KEYSTORE_KEY_ID = 'keystore'

export interface KeystoreContents {
  userId: string
  ecdh: RawKeyPair
  ecdsa: RawKeyPair
}

export interface KeystoreFile {
  v: number
  kdf: {
    algorithm: 'argon2id'
    iterations: number
    memorySize: number
    parallelism: number
    hashLength: number
    /** base64 */
    salt: string
  }
  /** base64 のエンベロープ */
  envelope: string
}

interface SerializedContents {
  userId: string
  ecdhPublic: string
  ecdhPrivate: string
  ecdsaPublic: string
  ecdsaPrivate: string
}

export async function createKeystore(
  contents: KeystoreContents,
  password: string,
  pepper: string,
  params: KdfParams = PRODUCTION_KDF,
): Promise<KeystoreFile> {
  const salt = randomBytes(SALT_BYTES)
  const kek = await deriveKek(password, pepper, salt, params)
  const payload: SerializedContents = {
    userId: contents.userId,
    ecdhPublic: toBase64(contents.ecdh.publicKey),
    ecdhPrivate: toBase64(contents.ecdh.privateKey),
    ecdsaPublic: toBase64(contents.ecdsa.publicKey),
    ecdsaPrivate: toBase64(contents.ecdsa.privateKey),
  }
  const envelope = await sealEnvelope(kek, KEYSTORE_KEY_ID, utf8(JSON.stringify(payload)))
  return {
    v: KEYSTORE_VERSION,
    kdf: {
      algorithm: params.algorithm,
      iterations: params.iterations,
      memorySize: params.memorySize,
      parallelism: params.parallelism,
      hashLength: params.hashLength,
      salt: toBase64(salt),
    },
    envelope: toBase64(envelope),
  }
}

export async function unlockKeystore(
  file: KeystoreFile,
  password: string,
  pepper: string,
): Promise<KeystoreContents> {
  const kek = await deriveKek(password, pepper, fromBase64(file.kdf.salt), {
    algorithm: file.kdf.algorithm,
    iterations: file.kdf.iterations,
    memorySize: file.kdf.memorySize,
    parallelism: file.kdf.parallelism,
    hashLength: file.kdf.hashLength,
  })
  let plaintext: Uint8Array
  try {
    plaintext = await openEnvelopeWithKey(kek, fromBase64(file.envelope))
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw new InvalidPasswordError('keystore could not be unlocked')
    }
    throw error
  }
  const payload = JSON.parse(fromUtf8(plaintext)) as SerializedContents
  return {
    userId: payload.userId,
    ecdh: {
      publicKey: fromBase64(payload.ecdhPublic),
      privateKey: fromBase64(payload.ecdhPrivate),
    },
    ecdsa: {
      publicKey: fromBase64(payload.ecdsaPublic),
      privateKey: fromBase64(payload.ecdsaPrivate),
    },
  }
}

export function serializeKeystoreFile(file: KeystoreFile): Uint8Array {
  return utf8(JSON.stringify(file))
}

export function parseKeystoreFile(bytes: Uint8Array): KeystoreFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new KeystoreFormatError('keystore is not valid JSON')
  }
  const file = parsed as KeystoreFile
  if (file === null || typeof file !== 'object') {
    throw new KeystoreFormatError('keystore is not an object')
  }
  if (file.v !== KEYSTORE_VERSION) {
    throw new KeystoreFormatError(`unsupported keystore version ${String(file.v)}`)
  }
  if (typeof file.envelope !== 'string' || file.kdf === null || typeof file.kdf !== 'object') {
    throw new KeystoreFormatError('keystore is missing required fields')
  }
  return file
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/crypto/keystore.test.ts
```

Expected: 7 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/crypto/keystore.ts tests/crypto/keystore.test.ts
git commit -m "feat(crypto): add password-protected keystore"
```

---

### Task 8: 鍵ラップとキーリング

**Files:**
- Create: `src/crypto/keyring.ts`
- Test: `tests/crypto/keyring.test.ts`

**Interfaces:**
- Consumes: Task 2 の `fromBase64` / `toBase64` / `utf8` / `fromUtf8`、Task 3 の `IV_BYTES` / `randomBytes` / `aesGcmEncrypt` / `aesGcmDecrypt` / `importAesKey` / `exportAesKey`、Task 4 の `generateEcdhKeyPair` / `importEcdhPublicKey` / `importEcdhPrivateKey`
- Produces: `class KeyUnwrapError extends Error`、`interface WrappedKey { epk: string; iv: string; ct: string }`、`interface KeyringEntry { scope: string; generation: number; wrapped: Record<string, WrappedKey> }`、`interface KeyringFile { v: number; generation: number; keys: Record<string, KeyringEntry> }`、`keyId(scope: string, generation: number): string` / `wrapKey(recipientEcdhPublic: Uint8Array, key: CryptoKey): Promise<WrappedKey>` / `unwrapKey(wrapped: WrappedKey, recipientEcdhPrivate: Uint8Array): Promise<CryptoKey>` / `unlockKeyring(file: KeyringFile, userId: string, ecdhPrivate: Uint8Array): Promise<Map<string, CryptoKey>>` / `serializeKeyringFile(file: KeyringFile): Uint8Array` / `parseKeyringFile(bytes: Uint8Array): KeyringFile`

鍵ラップは ECIES 相当とする。使い捨て(エフェメラル)の ECDH 鍵ペアを生成し、受信者の公開鍵と共有秘密を導出、HKDF-SHA256 で AES 鍵に伸長してグループ鍵を暗号化する。HKDF の salt にはエフェメラル公開鍵を使い、同じグループ鍵を複数人にラップしても導出鍵が重複しないようにする。

- [ ] **Step 1: 失敗するテストを書く**

`tests/crypto/keyring.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  KeyUnwrapError,
  keyId,
  wrapKey,
  unwrapKey,
  unlockKeyring,
  serializeKeyringFile,
  parseKeyringFile,
} from '../../src/crypto/keyring'
import type { KeyringFile } from '../../src/crypto/keyring'
import { generateEcdhKeyPair } from '../../src/crypto/asymmetric'
import { exportAesKey, generateAesKey } from '../../src/crypto/symmetric'
import { toHex } from '../../src/crypto/bytes'

describe('keyring', () => {
  it('formats key ids as scope:vN', () => {
    expect(keyId('sg_a', 3)).toBe('sg_a:v3')
  })

  it('unwraps a key wrapped for the holder', async () => {
    const recipient = await generateEcdhKeyPair()
    const groupKey = await generateAesKey()
    const wrapped = await wrapKey(recipient.publicKey, groupKey)
    const unwrapped = await unwrapKey(wrapped, recipient.privateKey)
    expect(toHex(await exportAesKey(unwrapped))).toBe(toHex(await exportAesKey(groupKey)))
  })

  it('produces a distinct ciphertext each time it wraps the same key', async () => {
    const recipient = await generateEcdhKeyPair()
    const groupKey = await generateAesKey()
    const a = await wrapKey(recipient.publicKey, groupKey)
    const b = await wrapKey(recipient.publicKey, groupKey)
    expect(a.ct).not.toBe(b.ct)
    expect(a.epk).not.toBe(b.epk)
  })

  it('refuses to unwrap with a different private key', async () => {
    const recipient = await generateEcdhKeyPair()
    const stranger = await generateEcdhKeyPair()
    const wrapped = await wrapKey(recipient.publicKey, await generateAesKey())
    await expect(unwrapKey(wrapped, stranger.privateKey)).rejects.toThrow(KeyUnwrapError)
  })

  it('returns only the keys wrapped for the given user', async () => {
    const alice = await generateEcdhKeyPair()
    const bob = await generateEcdhKeyPair()
    const allKey = await generateAesKey()
    const classKey = await generateAesKey()
    const file: KeyringFile = {
      v: 1,
      generation: 1,
      keys: {
        'all:v1': {
          scope: 'all',
          generation: 1,
          wrapped: {
            alice: await wrapKey(alice.publicKey, allKey),
            bob: await wrapKey(bob.publicKey, allKey),
          },
        },
        'sg_a:v1': {
          scope: 'sg_a',
          generation: 1,
          wrapped: { alice: await wrapKey(alice.publicKey, classKey) },
        },
      },
    }

    const aliceKeys = await unlockKeyring(file, 'alice', alice.privateKey)
    expect([...aliceKeys.keys()].sort()).toEqual(['all:v1', 'sg_a:v1'])

    const bobKeys = await unlockKeyring(file, 'bob', bob.privateKey)
    expect([...bobKeys.keys()]).toEqual(['all:v1'])
    expect(toHex(await exportAesKey(bobKeys.get('all:v1') as CryptoKey))).toBe(
      toHex(await exportAesKey(allKey)),
    )
  })

  it('returns an empty map for a user with no wrapped keys', async () => {
    const stranger = await generateEcdhKeyPair()
    const holder = await generateEcdhKeyPair()
    const file: KeyringFile = {
      v: 1,
      generation: 1,
      keys: {
        'all:v1': {
          scope: 'all',
          generation: 1,
          wrapped: { holder: await wrapKey(holder.publicKey, await generateAesKey()) },
        },
      },
    }
    expect((await unlockKeyring(file, 'stranger', stranger.privateKey)).size).toBe(0)
  })

  it('survives a serialize/parse round trip', async () => {
    const holder = await generateEcdhKeyPair()
    const groupKey = await generateAesKey()
    const file: KeyringFile = {
      v: 1,
      generation: 2,
      keys: {
        'all:v2': {
          scope: 'all',
          generation: 2,
          wrapped: { holder: await wrapKey(holder.publicKey, groupKey) },
        },
      },
    }
    const reparsed = parseKeyringFile(serializeKeyringFile(file))
    const keys = await unlockKeyring(reparsed, 'holder', holder.privateKey)
    expect(toHex(await exportAesKey(keys.get('all:v2') as CryptoKey))).toBe(
      toHex(await exportAesKey(groupKey)),
    )
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/crypto/keyring.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/crypto/keyring"`

- [ ] **Step 3: 実装する**

`src/crypto/keyring.ts`:

```ts
import {
  generateEcdhKeyPair,
  importEcdhPrivateKey,
  importEcdhPublicKey,
} from './asymmetric'
import { fromBase64, fromUtf8, toBase64, utf8 } from './bytes'
import {
  IV_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  exportAesKey,
  importAesKey,
  randomBytes,
} from './symmetric'

export class KeyUnwrapError extends Error {}
export class KeyringFormatError extends Error {}

export const KEYRING_VERSION = 1
const HKDF_INFO = utf8('mofune-keywrap-v1')

export interface WrappedKey {
  /** エフェメラル公開鍵 (base64, raw) */
  epk: string
  /** base64 */
  iv: string
  /** base64 */
  ct: string
}

export interface KeyringEntry {
  scope: string
  generation: number
  /** userId -> ラップ済みグループ鍵 */
  wrapped: Record<string, WrappedKey>
}

export interface KeyringFile {
  v: number
  generation: number
  /** keyId -> エントリ */
  keys: Record<string, KeyringEntry>
}

export function keyId(scope: string, generation: number): string {
  return `${scope}:v${generation}`
}

async function deriveWrappingKey(
  privatePkcs8: Uint8Array,
  publicRaw: Uint8Array,
  hkdfSalt: Uint8Array,
): Promise<CryptoKey> {
  const sharedBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importEcdhPublicKey(publicRaw) },
      await importEcdhPrivateKey(privatePkcs8),
      256,
    ),
  )
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, [
    'deriveBits',
  ])
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: HKDF_INFO },
      hkdfKey,
      256,
    ),
  )
  return importAesKey(derived)
}

export async function wrapKey(
  recipientEcdhPublic: Uint8Array,
  key: CryptoKey,
): Promise<WrappedKey> {
  const ephemeral = await generateEcdhKeyPair()
  const wrappingKey = await deriveWrappingKey(
    ephemeral.privateKey,
    recipientEcdhPublic,
    ephemeral.publicKey,
  )
  const iv = randomBytes(IV_BYTES)
  const ciphertext = await aesGcmEncrypt(wrappingKey, await exportAesKey(key), iv)
  return { epk: toBase64(ephemeral.publicKey), iv: toBase64(iv), ct: toBase64(ciphertext) }
}

export async function unwrapKey(
  wrapped: WrappedKey,
  recipientEcdhPrivate: Uint8Array,
): Promise<CryptoKey> {
  const ephemeralPublic = fromBase64(wrapped.epk)
  try {
    const wrappingKey = await deriveWrappingKey(
      recipientEcdhPrivate,
      ephemeralPublic,
      ephemeralPublic,
    )
    const raw = await aesGcmDecrypt(
      wrappingKey,
      fromBase64(wrapped.ct),
      fromBase64(wrapped.iv),
    )
    return await importAesKey(raw)
  } catch {
    throw new KeyUnwrapError('wrapped key could not be unwrapped with this private key')
  }
}

/** 指定ユーザー宛にラップされている鍵だけを復号して返す。 */
export async function unlockKeyring(
  file: KeyringFile,
  userId: string,
  ecdhPrivate: Uint8Array,
): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>()
  for (const [id, entry] of Object.entries(file.keys)) {
    const wrapped = entry.wrapped[userId]
    if (!wrapped) continue
    keys.set(id, await unwrapKey(wrapped, ecdhPrivate))
  }
  return keys
}

export function serializeKeyringFile(file: KeyringFile): Uint8Array {
  return utf8(JSON.stringify(file))
}

export function parseKeyringFile(bytes: Uint8Array): KeyringFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new KeyringFormatError('keyring is not valid JSON')
  }
  const file = parsed as KeyringFile
  if (file === null || typeof file !== 'object') {
    throw new KeyringFormatError('keyring is not an object')
  }
  if (file.v !== KEYRING_VERSION) {
    throw new KeyringFormatError(`unsupported keyring version ${String(file.v)}`)
  }
  if (file.keys === null || typeof file.keys !== 'object') {
    throw new KeyringFormatError('keyring is missing the keys map')
  }
  return file
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/crypto/keyring.test.ts
```

Expected: 7 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/crypto/keyring.ts tests/crypto/keyring.test.ts
git commit -m "feat(crypto): add ECIES key wrapping and the group keyring"
```

---

### Task 9: 署名付き名簿

**Files:**
- Create: `src/crypto/roster.ts`
- Test: `tests/crypto/roster.test.ts`

**Interfaces:**
- Consumes: Task 2 の `concat` / `equal` / `fromBase64` / `toBase64` / `utf8` / `fromUtf8`、Task 4 の `RawKeyPair` / `sign` / `verify`
- Produces: `type Role = 'admin' | 'staff' | 'member'`、`class RosterVerificationError extends Error`、`const ALL_SCOPE` / `const STAFF_SCOPE`、`interface Subgroup { id: string; name: string; parent: string | null }`、`interface RosterMember { userId: string; displayName: string; role: Role; scopes: string[]; ecdhPublic: string; ecdsaPublic: string }`、`interface RosterContents { groupId: string; generation: number; subgroups: Subgroup[]; members: RosterMember[] }`、`interface RosterFile { v: number; contents: string; staffSection: string | null; signature: string; adminPublicKey: string }`、`canonicalize(contents: RosterContents): Uint8Array` / `resolveScopes(subgroups: Subgroup[], role: Role, scopes: string[]): string[]` / `signRoster(contents: RosterContents, staffSection: Uint8Array | null, adminEcdsa: RawKeyPair): Promise<RosterFile>` / `verifyRoster(file: RosterFile, trustedAdminPublicKey: Uint8Array): Promise<RosterContents>` / `serializeRosterFile(file: RosterFile): Uint8Array` / `parseRosterFile(bytes: Uint8Array): RosterFile`

信頼の根は接続コードに埋め込まれた 管理者 の ECDSA 公開鍵。名簿ファイル自身が名乗る公開鍵は信用せず、必ず接続コード側の鍵と一致することを確認してから署名検証する。連絡先(メールアドレス)は `staffSection` にstaff スコープ鍵で暗号化して入れ、参加者からは復号できないようにする。

名簿はサブグループの木も持つ(設計書 §3.2)。`resolveScopes` は所属の伝播を1か所に集約する関数で、指定されたサブグループの**祖先すべて**と `all`、そして admin/staff には `staff` を加えた完全なスコープ集合を返す。呼び出し側(Task 13 のグループ作成)は末端のサブグループだけを指定すればよい。木は所属の伝播と表示にのみ使い、鍵の派生関係は持たせない — スコープ鍵はすべて独立に生成する。循環参照と親の不在は `RosterVerificationError` として弾く。

- [ ] **Step 1: 失敗するテストを書く**

`tests/crypto/roster.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  RosterVerificationError,
  ALL_SCOPE,
  STAFF_SCOPE,
  canonicalize,
  resolveScopes,
  signRoster,
  verifyRoster,
  serializeRosterFile,
  parseRosterFile,
} from '../../src/crypto/roster'
import type { RosterContents, Subgroup } from '../../src/crypto/roster'
import { generateEcdsaKeyPair } from '../../src/crypto/asymmetric'
import { fromUtf8, toBase64, utf8 } from '../../src/crypto/bytes'

const subgroups: Subgroup[] = [
  { id: 'sg_a', name: 'Aチーム', parent: null },
  { id: 'sg_a_pickup', name: '送迎係', parent: 'sg_a' },
  { id: 'sg_b', name: 'Bチーム', parent: null },
]

const contents: RosterContents = {
  groupId: 'midori',
  generation: 1,
  subgroups,
  members: [
    {
      userId: 'u_b',
      displayName: '田中 みか',
      role: 'staff',
      scopes: ['all', 'staff', 'sg_a'],
      ecdhPublic: 'BBBB',
      ecdsaPublic: 'bbbb',
    },
    {
      userId: 'u_a',
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: ['all', 'sg_a'],
      ecdhPublic: 'AAAA',
      ecdsaPublic: 'aaaa',
    },
  ],
}

describe('resolveScopes', () => {
  it('always grants the all scope', () => {
    expect(resolveScopes(subgroups, 'member', [])).toEqual([ALL_SCOPE])
  })

  it('grants the staff scope to admins and staff only', () => {
    expect(resolveScopes(subgroups, 'admin', [])).toContain(STAFF_SCOPE)
    expect(resolveScopes(subgroups, 'staff', [])).toContain(STAFF_SCOPE)
    expect(resolveScopes(subgroups, 'member', [])).not.toContain(STAFF_SCOPE)
  })

  it('propagates membership up to every ancestor subgroup', () => {
    expect(resolveScopes(subgroups, 'member', ['sg_a_pickup'])).toEqual([
      ALL_SCOPE,
      'sg_a',
      'sg_a_pickup',
    ])
  })

  it('does not grant a child subgroup to a member of its parent', () => {
    expect(resolveScopes(subgroups, 'member', ['sg_a'])).not.toContain('sg_a_pickup')
  })

  it('deduplicates overlapping memberships', () => {
    expect(resolveScopes(subgroups, 'member', ['sg_a', 'sg_a_pickup'])).toEqual([
      ALL_SCOPE,
      'sg_a',
      'sg_a_pickup',
    ])
  })

  it('rejects an unknown subgroup', () => {
    expect(() => resolveScopes(subgroups, 'member', ['sg_zzz'])).toThrow(
      RosterVerificationError,
    )
  })

  it('rejects a cycle in the subgroup tree', () => {
    const cyclic: Subgroup[] = [
      { id: 'sg_x', name: 'X', parent: 'sg_y' },
      { id: 'sg_y', name: 'Y', parent: 'sg_x' },
    ]
    expect(() => resolveScopes(cyclic, 'member', ['sg_x'])).toThrow(RosterVerificationError)
  })
})

describe('roster', () => {
  it('canonicalizes members in a stable order regardless of input order', () => {
    const reversed: RosterContents = { ...contents, members: [...contents.members].reverse() }
    expect(fromUtf8(canonicalize(contents))).toBe(fromUtf8(canonicalize(reversed)))
    const text = fromUtf8(canonicalize(contents))
    expect(text.indexOf('u_a')).toBeLessThan(text.indexOf('u_b'))
  })

  it('canonicalizes subgroups in a stable order regardless of input order', () => {
    const reversed: RosterContents = {
      ...contents,
      subgroups: [...contents.subgroups].reverse(),
    }
    expect(fromUtf8(canonicalize(contents))).toBe(fromUtf8(canonicalize(reversed)))
  })

  it('rejects a roster whose subgroup tree was modified after signing', async () => {
    const admin = await generateEcdsaKeyPair()
    const file = await signRoster(contents, null, admin)
    const moved: RosterContents = {
      ...contents,
      subgroups: subgroups.map((subgroup) =>
        subgroup.id === 'sg_a_pickup' ? { ...subgroup, parent: 'sg_b' } : subgroup,
      ),
    }
    const forged = { ...file, contents: toBase64(canonicalize(moved)) }
    await expect(verifyRoster(forged, admin.publicKey)).rejects.toThrow(
      RosterVerificationError,
    )
  })

  it('verifies a roster signed by the trusted admin key', async () => {
    const admin = await generateEcdsaKeyPair()
    const file = await signRoster(contents, null, admin)
    const verified = await verifyRoster(file, admin.publicKey)
    expect(verified.groupId).toBe('midori')
    expect(verified.members).toHaveLength(2)
  })

  it('rejects a roster signed by a different key', async () => {
    const admin = await generateEcdsaKeyPair()
    const impostor = await generateEcdsaKeyPair()
    const file = await signRoster(contents, null, impostor)
    await expect(verifyRoster(file, admin.publicKey)).rejects.toThrow(RosterVerificationError)
  })

  it('rejects a roster whose contents were modified after signing', async () => {
    const admin = await generateEcdsaKeyPair()
    const file = await signRoster(contents, null, admin)
    const tampered: RosterContents = {
      ...contents,
      members: [
        ...contents.members,
        {
          userId: 'u_x',
          displayName: '侵入者',
          role: 'admin',
          scopes: ['all', 'staff'],
          ecdhPublic: 'XXXX',
          ecdsaPublic: 'xxxx',
        },
      ],
    }
    const forged = { ...file, contents: toBase64(canonicalize(tampered)) }
    await expect(verifyRoster(forged, admin.publicKey)).rejects.toThrow(
      RosterVerificationError,
    )
  })

  it('rejects a roster whose staff section was swapped', async () => {
    const admin = await generateEcdsaKeyPair()
    const file = await signRoster(contents, utf8('sealed-contacts'), admin)
    const forged = { ...file, staffSection: toBase64(utf8('other-contacts')) }
    await expect(verifyRoster(forged, admin.publicKey)).rejects.toThrow(
      RosterVerificationError,
    )
  })

  it('carries the staff section through a signature round trip', async () => {
    const admin = await generateEcdsaKeyPair()
    const file = await signRoster(contents, utf8('sealed-contacts'), admin)
    await expect(verifyRoster(file, admin.publicKey)).resolves.toBeDefined()
    expect(file.staffSection).toBe(toBase64(utf8('sealed-contacts')))
  })

  it('survives a serialize/parse round trip', async () => {
    const admin = await generateEcdsaKeyPair()
    const file = await signRoster(contents, null, admin)
    const reparsed = parseRosterFile(serializeRosterFile(file))
    await expect(verifyRoster(reparsed, admin.publicKey)).resolves.toBeDefined()
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/crypto/roster.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/crypto/roster"`

- [ ] **Step 3: 実装する**

`src/crypto/roster.ts`:

```ts
import type { RawKeyPair } from './asymmetric'
import { sign, verify } from './asymmetric'
import { concat, equal, fromBase64, fromUtf8, toBase64, utf8 } from './bytes'

export class RosterVerificationError extends Error {}
export class RosterFormatError extends Error {}

export const ROSTER_VERSION = 1

/** グループ全体。全メンバーが持つ。 */
export const ALL_SCOPE = 'all'
/** 担当者のみ。連絡先の封緘に使う。 */
export const STAFF_SCOPE = 'staff'

export type Role = 'admin' | 'staff' | 'member'

export interface Subgroup {
  id: string
  name: string
  /** 親サブグループの id。トップレベルは null。 */
  parent: string | null
}

export interface RosterMember {
  userId: string
  displayName: string
  role: Role
  scopes: string[]
  /** base64, raw ECDH public key */
  ecdhPublic: string
  /** base64, raw ECDSA public key */
  ecdsaPublic: string
}

export interface RosterContents {
  groupId: string
  generation: number
  subgroups: Subgroup[]
  members: RosterMember[]
}

/**
 * 末端の所属から完全なスコープ集合を作る。祖先サブグループと all、
 * admin/staff には staff を加える。返り値は昇順で重複なし。
 * 木は所属の伝播にのみ使い、鍵の派生には使わない(設計書 §3.2)。
 */
export function resolveScopes(
  subgroups: Subgroup[],
  role: Role,
  scopes: string[],
): string[] {
  const byId = new Map(subgroups.map((subgroup) => [subgroup.id, subgroup]))
  const resolved = new Set<string>([ALL_SCOPE])
  if (role === 'admin' || role === 'staff') {
    resolved.add(STAFF_SCOPE)
  }
  for (const scope of scopes) {
    let current = byId.get(scope)
    if (!current) {
      throw new RosterVerificationError(`unknown subgroup "${scope}"`)
    }
    const seen = new Set<string>()
    while (current) {
      if (seen.has(current.id)) {
        throw new RosterVerificationError(`subgroup tree has a cycle at "${current.id}"`)
      }
      seen.add(current.id)
      resolved.add(current.id)
      if (current.parent === null) break
      const parent = byId.get(current.parent)
      if (!parent) {
        throw new RosterVerificationError(`unknown parent subgroup "${current.parent}"`)
      }
      current = parent
    }
  }
  return [...resolved].sort()
}

export interface RosterFile {
  v: number
  /** base64 of the canonical contents */
  contents: string
  /** base64 のエンベロープ。staff スコープ鍵で暗号化された連絡先。 */
  staffSection: string | null
  /** base64 */
  signature: string
  /** base64。接続コード側の鍵と一致することを必ず確認する。 */
  adminPublicKey: string
}

/**
 * 署名対象を安定させるための正規形。サブグループは id 昇順、メンバーは userId 昇順、
 * scopes も昇順に並べ替え、キーの出現順を固定する。
 */
export function canonicalize(contents: RosterContents): Uint8Array {
  const subgroups = [...contents.subgroups]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((subgroup) => ({
      id: subgroup.id,
      name: subgroup.name,
      parent: subgroup.parent,
    }))
  const members = [...contents.members]
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .map((member) => ({
      userId: member.userId,
      displayName: member.displayName,
      role: member.role,
      scopes: [...member.scopes].sort(),
      ecdhPublic: member.ecdhPublic,
      ecdsaPublic: member.ecdsaPublic,
    }))
  return utf8(
    JSON.stringify({
      groupId: contents.groupId,
      generation: contents.generation,
      subgroups,
      members,
    }),
  )
}

/** contents と staffSection の両方を署名対象に含める。区切りの "." で境界を固定する。 */
function signedBytes(contentsBase64: string, staffSection: string | null): Uint8Array {
  return concat(utf8(contentsBase64), utf8('.'), utf8(staffSection ?? ''))
}

export async function signRoster(
  contents: RosterContents,
  staffSection: Uint8Array | null,
  adminEcdsa: RawKeyPair,
): Promise<RosterFile> {
  const contentsBase64 = toBase64(canonicalize(contents))
  const staffBase64 = staffSection ? toBase64(staffSection) : null
  const signature = await sign(
    adminEcdsa.privateKey,
    signedBytes(contentsBase64, staffBase64),
  )
  return {
    v: ROSTER_VERSION,
    contents: contentsBase64,
    staffSection: staffBase64,
    signature: toBase64(signature),
    adminPublicKey: toBase64(adminEcdsa.publicKey),
  }
}

export async function verifyRoster(
  file: RosterFile,
  trustedAdminPublicKey: Uint8Array,
): Promise<RosterContents> {
  if (file.v !== ROSTER_VERSION) {
    throw new RosterVerificationError(`unsupported roster version ${String(file.v)}`)
  }
  if (!equal(fromBase64(file.adminPublicKey), trustedAdminPublicKey)) {
    throw new RosterVerificationError(
      'roster admin key does not match the key from the connection code',
    )
  }
  const valid = await verify(
    trustedAdminPublicKey,
    fromBase64(file.signature),
    signedBytes(file.contents, file.staffSection),
  )
  if (!valid) {
    throw new RosterVerificationError('roster signature is invalid')
  }
  return JSON.parse(fromUtf8(fromBase64(file.contents))) as RosterContents
}

export function serializeRosterFile(file: RosterFile): Uint8Array {
  return utf8(JSON.stringify(file))
}

export function parseRosterFile(bytes: Uint8Array): RosterFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new RosterFormatError('roster is not valid JSON')
  }
  const file = parsed as RosterFile
  if (file === null || typeof file !== 'object') {
    throw new RosterFormatError('roster is not an object')
  }
  if (
    typeof file.contents !== 'string' ||
    typeof file.signature !== 'string' ||
    typeof file.adminPublicKey !== 'string'
  ) {
    throw new RosterFormatError('roster is missing required fields')
  }
  return file
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/crypto/roster.test.ts
```

Expected: 16 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/crypto/roster.ts tests/crypto/roster.test.ts
git commit -m "feat(crypto): add admin-signed roster with a staff-only section"
```

---

### Task 10: 接続コードと manifest

**Files:**
- Create: `src/group/connection-code.ts`, `src/group/manifest.ts`
- Test: `tests/group/connection-code.test.ts`, `tests/group/manifest.test.ts`

**Interfaces:**
- Consumes: Task 2 の `utf8` / `fromUtf8` / `toBase64Url` / `fromBase64Url`
- Produces: `type ProviderKind = 'http' | 's3' | 'gdrive' | 'dropbox' | 'webdav'`、`class ConnectionCodeError extends Error`、`interface ConnectionCode { v: number; groupId: string; provider: ProviderKind; root: string; pepper: string; adminPublicKey: string }`、`encodeConnectionCode(code: ConnectionCode): string` / `decodeConnectionCode(text: string): ConnectionCode`、`class ManifestError extends Error`、`interface Manifest { v: number; groupId: string; groupName: string; keyringGeneration: number; rosterGeneration: number; functionUrl: string | null; notificationChannels: string[] }`、`encodeManifest(manifest: Manifest): Uint8Array` / `decodeManifest(bytes: Uint8Array): Manifest`

接続コードは紙(QR)で配る。秘密情報ではないが、ペッパーと信頼の根(管理者 公開鍵)を運ぶため、これを持たない第三者はストレージを入手しても総当たりを開始できず、名簿の真正性も検証できない。

- [ ] **Step 1: 失敗するテストを書く**

`tests/group/connection-code.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  ConnectionCodeError,
  encodeConnectionCode,
  decodeConnectionCode,
} from '../../src/group/connection-code'
import type { ConnectionCode } from '../../src/group/connection-code'
import { toBase64Url, utf8 } from '../../src/crypto/bytes'

const code: ConnectionCode = {
  v: 1,
  groupId: 'midori',
  provider: 's3',
  root: 'https://example.invalid/mofune',
  pepper: 'cGVwcGVy',
  adminPublicKey: 'BAAA',
}

describe('connection code', () => {
  it('round-trips a code', () => {
    expect(decodeConnectionCode(encodeConnectionCode(code))).toEqual(code)
  })

  it('produces a URL-safe string', () => {
    expect(encodeConnectionCode(code)).not.toMatch(/[+/=]/)
  })

  it('tolerates surrounding whitespace from a paper transcription', () => {
    expect(decodeConnectionCode(`  ${encodeConnectionCode(code)}\n`)).toEqual(code)
  })

  it('rejects text that is not valid base64url JSON', () => {
    expect(() => decodeConnectionCode('not-a-code!!')).toThrow(ConnectionCodeError)
  })

  it('rejects an unknown version', () => {
    const bad = toBase64Url(utf8(JSON.stringify({ ...code, v: 99 })))
    expect(() => decodeConnectionCode(bad)).toThrow(/version/)
  })

  it('rejects an unknown provider', () => {
    const bad = toBase64Url(utf8(JSON.stringify({ ...code, provider: 'ftp' })))
    expect(() => decodeConnectionCode(bad)).toThrow(/provider/)
  })

  it('rejects a code missing the admin public key', () => {
    const bad = toBase64Url(utf8(JSON.stringify({ ...code, adminPublicKey: '' })))
    expect(() => decodeConnectionCode(bad)).toThrow(ConnectionCodeError)
  })
})
```

`tests/group/manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ManifestError, encodeManifest, decodeManifest } from '../../src/group/manifest'
import type { Manifest } from '../../src/group/manifest'
import { utf8 } from '../../src/crypto/bytes'

const manifest: Manifest = {
  v: 1,
  groupId: 'midori',
  groupName: 'みどり台グループ',
  keyringGeneration: 1,
  rosterGeneration: 1,
  functionUrl: null,
  notificationChannels: ['mailto'],
}

describe('manifest', () => {
  it('round-trips a manifest', () => {
    expect(decodeManifest(encodeManifest(manifest))).toEqual(manifest)
  })

  it('rejects invalid JSON', () => {
    expect(() => decodeManifest(utf8('{'))).toThrow(ManifestError)
  })

  it('rejects an unknown version', () => {
    expect(() => decodeManifest(utf8(JSON.stringify({ ...manifest, v: 99 })))).toThrow(
      /version/,
    )
  })

  it('rejects a manifest without a keyring generation', () => {
    const bad = JSON.stringify({ ...manifest, keyringGeneration: 'one' })
    expect(() => decodeManifest(utf8(bad))).toThrow(ManifestError)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/group/connection-code.test.ts tests/group/manifest.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/group/connection-code"`

- [ ] **Step 3: 接続コードを実装する**

`src/group/connection-code.ts`:

```ts
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from '../crypto/bytes'

export class ConnectionCodeError extends Error {}

export const CONNECTION_CODE_VERSION = 1

export type ProviderKind = 'http' | 's3' | 'gdrive' | 'dropbox' | 'webdav'

const PROVIDER_KINDS: readonly ProviderKind[] = [
  'http',
  's3',
  'gdrive',
  'dropbox',
  'webdav',
]

export interface ConnectionCode {
  v: number
  groupId: string
  provider: ProviderKind
  /** バケット URL やフォルダ ID など、プロバイダ固有のルート位置 */
  root: string
  /** KDF ペッパー。ストレージには置かず、このコードだけが運ぶ。 */
  pepper: string
  /** base64, raw ECDSA public key。名簿検証の信頼の根。 */
  adminPublicKey: string
}

export function encodeConnectionCode(code: ConnectionCode): string {
  return toBase64Url(utf8(JSON.stringify(code)))
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConnectionCodeError(`connection code field "${field}" is missing`)
  }
  return value
}

export function decodeConnectionCode(text: string): ConnectionCode {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(fromBase64Url(text.trim())))
  } catch {
    throw new ConnectionCodeError('connection code is not readable')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new ConnectionCodeError('connection code is not an object')
  }
  const candidate = parsed as Record<string, unknown>
  if (candidate.v !== CONNECTION_CODE_VERSION) {
    throw new ConnectionCodeError(
      `unsupported connection code version ${String(candidate.v)}`,
    )
  }
  const provider = candidate.provider
  if (typeof provider !== 'string' || !PROVIDER_KINDS.includes(provider as ProviderKind)) {
    throw new ConnectionCodeError(`unsupported storage provider "${String(provider)}"`)
  }
  return {
    v: CONNECTION_CODE_VERSION,
    groupId: requireNonEmptyString(candidate.groupId, 'groupId'),
    provider: provider as ProviderKind,
    root: requireNonEmptyString(candidate.root, 'root'),
    pepper: requireNonEmptyString(candidate.pepper, 'pepper'),
    adminPublicKey: requireNonEmptyString(candidate.adminPublicKey, 'adminPublicKey'),
  }
}
```

- [ ] **Step 4: manifest を実装する**

`src/group/manifest.ts`:

```ts
import { fromUtf8, utf8 } from '../crypto/bytes'

export class ManifestError extends Error {}

export const MANIFEST_VERSION = 1

/** 平文で保存される唯一のグループメタデータ。個人情報を入れてはならない。 */
export interface Manifest {
  v: number
  groupId: string
  groupName: string
  keyringGeneration: number
  rosterGeneration: number
  /** 任意の関数層のエンドポイント。未導入なら null。 */
  functionUrl: string | null
  notificationChannels: string[]
}

export function encodeManifest(manifest: Manifest): Uint8Array {
  return utf8(JSON.stringify(manifest))
}

export function decodeManifest(bytes: Uint8Array): Manifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new ManifestError('manifest is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new ManifestError('manifest is not an object')
  }
  const candidate = parsed as Record<string, unknown>
  if (candidate.v !== MANIFEST_VERSION) {
    throw new ManifestError(`unsupported manifest version ${String(candidate.v)}`)
  }
  if (
    typeof candidate.groupId !== 'string' ||
    typeof candidate.groupName !== 'string' ||
    typeof candidate.keyringGeneration !== 'number' ||
    typeof candidate.rosterGeneration !== 'number'
  ) {
    throw new ManifestError('manifest is missing required fields')
  }
  return {
    v: MANIFEST_VERSION,
    groupId: candidate.groupId,
    groupName: candidate.groupName,
    keyringGeneration: candidate.keyringGeneration,
    rosterGeneration: candidate.rosterGeneration,
    functionUrl: typeof candidate.functionUrl === 'string' ? candidate.functionUrl : null,
    notificationChannels: Array.isArray(candidate.notificationChannels)
      ? candidate.notificationChannels.filter(
          (channel): channel is string => typeof channel === 'string',
        )
      : [],
  }
}
```

- [ ] **Step 5: テストを実行して成功を確認する**

```bash
npx vitest run tests/group/connection-code.test.ts tests/group/manifest.test.ts
```

Expected: 11 tests passed

- [ ] **Step 6: コミット**

```bash
git add src/group tests/group
git commit -m "feat(group): add connection code and manifest codecs"
```

---

### Task 11: ストレージ抽象とインメモリ実装

**Files:**
- Create: `src/storage/provider.ts`, `src/storage/paths.ts`, `src/storage/memory.ts`
- Test: `tests/storage/paths.test.ts`, `tests/storage/memory.test.ts`

**Interfaces:**
- Consumes: Task 2 の `toHex` / `utf8`、Task 3 の `sha256`
- Produces: `class NotFoundError extends Error` / `class UnsupportedOperationError extends Error`、`interface StorageEntry { path: string; size: number }`、`interface StorageCapabilities { read: boolean; write: boolean; list: boolean; inbox: boolean }`、`interface StorageProvider { capabilities; get(path); put(path, data); list(prefix); delete(path) }`、`class MemoryStorageProvider implements StorageProvider`、パス生成関数群 `manifestPath` / `rosterPath` / `keyringPath` / `keystorePath` / `messagePath` / `filePath` / `eventPath` / `inboxPath`

`keystorePath` はログイン ID を直接パスに出さない。公開ストレージ上で在籍者を列挙されるのを防ぐため、`SHA-256(groupId + ':' + 正規化ログインID)` のハッシュをファイル名にする。

- [ ] **Step 1: 失敗するテストを書く**

`tests/storage/paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  manifestPath,
  rosterPath,
  keyringPath,
  keystorePath,
  messagePath,
  filePath,
  eventPath,
  inboxPath,
} from '../../src/storage/paths'

describe('storage paths', () => {
  it('builds the fixed top-level paths', () => {
    expect(manifestPath('midori')).toBe('midori/manifest.json')
    expect(rosterPath('midori')).toBe('midori/roster.sig.json')
  })

  it('zero-pads the keyring generation so paths sort in order', () => {
    expect(keyringPath('midori', 1)).toBe('midori/keyring/v001.json')
    expect(keyringPath('midori', 42)).toBe('midori/keyring/v042.json')
  })

  it('hashes the login id into the keystore path', async () => {
    const path = await keystorePath('midori', 'sato')
    expect(path).toMatch(/^midori\/users\/[0-9a-f]{64}\.json$/)
    expect(path).not.toContain('sato')
  })

  it('normalizes the login id case and surrounding whitespace', async () => {
    expect(await keystorePath('midori', '  SATO ')).toBe(await keystorePath('midori', 'sato'))
  })

  it('separates keystores across groups for the same login id', async () => {
    expect(await keystorePath('midori', 'sato')).not.toBe(await keystorePath('aozora', 'sato'))
  })

  it('builds content paths', () => {
    expect(messagePath('midori', 'm1')).toBe('midori/messages/m1.enc')
    expect(filePath('midori', 'f1')).toBe('midori/files/f1.enc')
    expect(eventPath('midori', 'e1')).toBe('midori/events/e1.enc')
    expect(inboxPath('midori', 'u_a', 'i1')).toBe('midori/inbox/u_a/i1.enc')
  })
})
```

`tests/storage/memory.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { NotFoundError } from '../../src/storage/provider'
import { utf8, fromUtf8 } from '../../src/crypto/bytes'

describe('MemoryStorageProvider', () => {
  it('stores and returns bytes', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('a/b.json', utf8('hello'))
    expect(fromUtf8(await storage.get('a/b.json'))).toBe('hello')
  })

  it('throws NotFoundError for a missing path', async () => {
    const storage = new MemoryStorageProvider()
    await expect(storage.get('missing')).rejects.toThrow(NotFoundError)
  })

  it('overwrites an existing path', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('a', utf8('one'))
    await storage.put('a', utf8('two'))
    expect(fromUtf8(await storage.get('a'))).toBe('two')
  })

  it('lists paths under a prefix in sorted order', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('g/events/2.enc', utf8('b'))
    await storage.put('g/events/1.enc', utf8('a'))
    await storage.put('g/messages/1.enc', utf8('c'))
    expect((await storage.list('g/events/')).map((entry) => entry.path)).toEqual([
      'g/events/1.enc',
      'g/events/2.enc',
    ])
  })

  it('reports the stored size', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('a', utf8('12345'))
    expect((await storage.list('a'))[0]?.size).toBe(5)
  })

  it('deletes a path', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('a', utf8('x'))
    await storage.delete('a')
    await expect(storage.get('a')).rejects.toThrow(NotFoundError)
  })

  it('returns a defensive copy so callers cannot mutate stored bytes', async () => {
    const storage = new MemoryStorageProvider()
    await storage.put('a', utf8('hello'))
    const first = await storage.get('a')
    first[0] = 0
    expect(fromUtf8(await storage.get('a'))).toBe('hello')
  })

  it('can be seeded from a map of objects', async () => {
    const storage = new MemoryStorageProvider(new Map([['a', utf8('seeded')]]))
    expect(fromUtf8(await storage.get('a'))).toBe('seeded')
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/storage/
```

Expected: FAIL — `Failed to resolve import "../../src/storage/paths"`

- [ ] **Step 3: インターフェースとパスを実装する**

`src/storage/provider.ts`:

```ts
export class NotFoundError extends Error {}
export class UnsupportedOperationError extends Error {}

export interface StorageEntry {
  path: string
  size: number
}

export interface StorageCapabilities {
  read: boolean
  write: boolean
  list: boolean
  /** 認証アカウントを持たない利用者が自分の区画にだけ書ける経路があるか */
  inbox: boolean
}

export interface StorageProvider {
  readonly capabilities: StorageCapabilities
  /** 見つからない場合は NotFoundError を投げる。 */
  get(path: string): Promise<Uint8Array>
  put(path: string, data: Uint8Array): Promise<void>
  list(prefix: string): Promise<StorageEntry[]>
  delete(path: string): Promise<void>
}
```

`src/storage/paths.ts`:

```ts
import { toHex, utf8 } from '../crypto/bytes'
import { sha256 } from '../crypto/symmetric'

export function manifestPath(groupId: string): string {
  return `${groupId}/manifest.json`
}

export function rosterPath(groupId: string): string {
  return `${groupId}/roster.sig.json`
}

export function keyringPath(groupId: string, generation: number): string {
  return `${groupId}/keyring/v${String(generation).padStart(3, '0')}.json`
}

/**
 * ログイン ID をそのままパスに出すと、公開ストレージ上で在籍者を
 * 列挙できてしまう。ハッシュしてから配置する。
 */
export async function keystorePath(groupId: string, loginId: string): Promise<string> {
  const digest = await sha256(utf8(`${groupId}:${loginId.trim().toLowerCase()}`))
  return `${groupId}/users/${toHex(digest)}.json`
}

export function messagePath(groupId: string, messageId: string): string {
  return `${groupId}/messages/${messageId}.enc`
}

export function filePath(groupId: string, fileId: string): string {
  return `${groupId}/files/${fileId}.enc`
}

export function eventPath(groupId: string, eventId: string): string {
  return `${groupId}/events/${eventId}.enc`
}

export function inboxPath(groupId: string, userId: string, itemId: string): string {
  return `${groupId}/inbox/${userId}/${itemId}.enc`
}
```

- [ ] **Step 4: インメモリ実装を書く**

`src/storage/memory.ts`:

```ts
import type { StorageCapabilities, StorageEntry, StorageProvider } from './provider'
import { NotFoundError } from './provider'

/** テストと開発用。全ての操作をサポートする。 */
export class MemoryStorageProvider implements StorageProvider {
  readonly capabilities: StorageCapabilities = {
    read: true,
    write: true,
    list: true,
    inbox: true,
  }

  private readonly objects: Map<string, Uint8Array>

  constructor(seed?: Map<string, Uint8Array>) {
    this.objects = new Map()
    if (seed) {
      for (const [path, data] of seed) {
        this.objects.set(path, Uint8Array.from(data))
      }
    }
  }

  async get(path: string): Promise<Uint8Array> {
    const data = this.objects.get(path)
    if (!data) throw new NotFoundError(`no object at "${path}"`)
    return Uint8Array.from(data)
  }

  async put(path: string, data: Uint8Array): Promise<void> {
    this.objects.set(path, Uint8Array.from(data))
  }

  async list(prefix: string): Promise<StorageEntry[]> {
    return [...this.objects.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, data]) => ({ path, size: data.length }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  async delete(path: string): Promise<void> {
    this.objects.delete(path)
  }
}
```

- [ ] **Step 5: テストを実行して成功を確認する**

```bash
npx vitest run tests/storage/
```

Expected: 14 tests passed

- [ ] **Step 6: コミット**

```bash
git add src/storage tests/storage
git commit -m "feat(storage): add provider interface, layout paths and in-memory provider"
```

---

### Task 12: 公開読み取り専用 HTTP プロバイダ

**Files:**
- Create: `src/storage/http.ts`
- Test: `tests/storage/http.test.ts`

**Interfaces:**
- Consumes: Task 11 の `StorageProvider` / `NotFoundError` / `UnsupportedOperationError`
- Produces: `class HttpStorageProvider implements StorageProvider`(コンストラクタ引数 `root: string`)

参加者はストレージのアカウントを持たないため、配信は素の HTTP GET で行う。書き込みと一覧はこのプロバイダの責務ではなく、`UnsupportedOperationError` を投げる(上りは Phase 2 の inbox が担当する)。S3 互換ストレージは一覧権限が無いと存在しないオブジェクトに 403 を返すため、403 も `NotFoundError` として扱う。

- [ ] **Step 1: 失敗するテストを書く**

`tests/storage/http.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpStorageProvider } from '../../src/storage/http'
import { NotFoundError, UnsupportedOperationError } from '../../src/storage/provider'
import { utf8, fromUtf8 } from '../../src/crypto/bytes'

function mockFetch(response: Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(response)),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpStorageProvider', () => {
  it('declares itself read-only', () => {
    const storage = new HttpStorageProvider('https://example.invalid/mofune')
    expect(storage.capabilities).toEqual({
      read: true,
      write: false,
      list: false,
      inbox: false,
    })
  })

  it('fetches an object by joining root and path', async () => {
    const fetchMock = vi.fn((_url: string) => Promise.resolve(new Response(utf8('payload'))))
    vi.stubGlobal('fetch', fetchMock)
    const storage = new HttpStorageProvider('https://example.invalid/mofune/')
    expect(fromUtf8(await storage.get('midori/manifest.json'))).toBe('payload')
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.invalid/mofune/midori/manifest.json',
    )
  })

  it('maps 404 to NotFoundError', async () => {
    mockFetch(new Response('', { status: 404 }))
    const storage = new HttpStorageProvider('https://example.invalid')
    await expect(storage.get('missing')).rejects.toThrow(NotFoundError)
  })

  it('maps 403 to NotFoundError because S3 hides missing objects that way', async () => {
    mockFetch(new Response('', { status: 403 }))
    const storage = new HttpStorageProvider('https://example.invalid')
    await expect(storage.get('missing')).rejects.toThrow(NotFoundError)
  })

  it('surfaces other HTTP failures as generic errors', async () => {
    mockFetch(new Response('', { status: 500 }))
    const storage = new HttpStorageProvider('https://example.invalid')
    await expect(storage.get('x')).rejects.toThrow(/500/)
  })

  it('rejects write and list operations', async () => {
    const storage = new HttpStorageProvider('https://example.invalid')
    await expect(storage.put('a', utf8('x'))).rejects.toThrow(UnsupportedOperationError)
    await expect(storage.list('a')).rejects.toThrow(UnsupportedOperationError)
    await expect(storage.delete('a')).rejects.toThrow(UnsupportedOperationError)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/storage/http.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/storage/http"`

- [ ] **Step 3: 実装する**

`src/storage/http.ts`:

```ts
import type { StorageCapabilities, StorageEntry, StorageProvider } from './provider'
import { NotFoundError, UnsupportedOperationError } from './provider'

/**
 * 公開読み取り専用のプロバイダ。参加者はストレージのアカウントを持たないため、
 * 配信経路は素の HTTP GET になる。全データは E2E 暗号化済みである前提。
 */
export class HttpStorageProvider implements StorageProvider {
  readonly capabilities: StorageCapabilities = {
    read: true,
    write: false,
    list: false,
    inbox: false,
  }

  private readonly root: string

  constructor(root: string) {
    this.root = root.replace(/\/+$/, '')
  }

  async get(path: string): Promise<Uint8Array> {
    const response = await fetch(`${this.root}/${path}`, { cache: 'no-store' })
    // S3 互換ストレージは一覧権限が無い場合、存在しないオブジェクトに 403 を返す。
    if (response.status === 404 || response.status === 403) {
      throw new NotFoundError(`no object at "${path}"`)
    }
    if (!response.ok) {
      throw new Error(`storage GET "${path}" failed with status ${response.status}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  async put(_path: string, _data: Uint8Array): Promise<void> {
    throw new UnsupportedOperationError('HttpStorageProvider is read-only')
  }

  async list(_prefix: string): Promise<StorageEntry[]> {
    throw new UnsupportedOperationError('HttpStorageProvider cannot list objects')
  }

  async delete(_path: string): Promise<void> {
    throw new UnsupportedOperationError('HttpStorageProvider is read-only')
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/storage/http.test.ts
```

Expected: 6 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/storage/http.ts tests/storage/http.test.ts
git commit -m "feat(storage): add public read-only HTTP provider"
```

---

### Task 13: グループ新規作成

**Files:**
- Create: `src/group/provision.ts`
- Test: `tests/group/provision.test.ts`

**Interfaces:**
- Consumes: Task 4 の `generateEcdhKeyPair` / `generateEcdsaKeyPair`、Task 3 の `generateAesKey` / `randomBytes`、Task 5 の `sealEnvelope`、Task 7 の `createKeystore` / `serializeKeystoreFile`、Task 8 の `keyId` / `wrapKey` / `serializeKeyringFile` / `KeyringFile`、Task 9 の `Role` / `Subgroup` / `RosterMember` / `ALL_SCOPE` / `STAFF_SCOPE` / `resolveScopes` / `signRoster` / `serializeRosterFile`、Task 10 の `ConnectionCode` / `ProviderKind` / `encodeManifest`、Task 11 のパス生成関数と `StorageProvider`
- Produces: `class ProvisionError extends Error`、`interface NewMember { loginId: string; displayName: string; role: Role; scopes: string[]; password: string; email: string }`、`interface ProvisionOptions { groupId: string; groupName: string; provider: ProviderKind; root: string; subgroups: Subgroup[]; members: NewMember[]; kdf?: KdfParams }`、`interface ProvisionResult { code: ConnectionCode; objects: Map<string, Uint8Array> }`、`provisionGroup(options: ProvisionOptions): Promise<ProvisionResult>` / `writeObjects(storage: StorageProvider, objects: Map<string, Uint8Array>): Promise<void>`

管理者 がグループを開設する処理。サブグループ木・全メンバーの鍵ペア・キーストア・キーリング・名簿・manifest を生成し、ストレージへ書き込むオブジェクト一式を返す。ログイン経路の統合テストもこれを使って組み立てるため、テスト専用のフィクスチャを別に作らない。

スコープの確定は Task 9 の `resolveScopes` に委譲する。呼び出し側は末端のサブグループだけを指定すればよく、`all` と祖先サブグループ、admin/staff への `staff` は自動的に付く。キーリングには使用中の全スコープぶんの鍵を作り、そのスコープに属するメンバーだけへラップする。

- [ ] **Step 1: 失敗するテストを書く**

`tests/group/provision.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { provisionGroup, writeObjects } from '../../src/group/provision'
import type { NewMember, ProvisionOptions } from '../../src/group/provision'
import { TEST_KDF } from '../../src/crypto/kdf'
import { parseKeystoreFile, unlockKeystore } from '../../src/crypto/keystore'
import { parseKeyringFile, unlockKeyring } from '../../src/crypto/keyring'
import { ALL_SCOPE, STAFF_SCOPE, parseRosterFile, verifyRoster } from '../../src/crypto/roster'
import { openEnvelopeWithKey } from '../../src/crypto/envelope'
import { decodeManifest } from '../../src/group/manifest'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { keyringPath, keystorePath, manifestPath, rosterPath } from '../../src/storage/paths'
import { fromBase64, fromUtf8 } from '../../src/crypto/bytes'

const options: ProvisionOptions = {
  groupId: 'midori',
  groupName: 'みどり台グループ',
  provider: 'http',
  root: 'https://example.invalid/mofune',
  kdf: TEST_KDF,
  subgroups: [
    { id: 'sg_a', name: 'Aチーム', parent: null },
    { id: 'sg_a_pickup', name: '送迎係', parent: 'sg_a' },
  ],
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
      scopes: ['sg_a'],
      password: 'staff-pass',
      email: 'tanaka@example.invalid',
    },
    {
      loginId: 'sato',
      displayName: '佐藤 さくら',
      role: 'member',
      scopes: ['sg_a'],
      password: 'member-pass',
      email: 'sato@example.invalid',
    },
    {
      loginId: 'mori',
      displayName: '森 ゆい',
      role: 'member',
      scopes: ['sg_a_pickup'],
      password: 'member-pass',
      email: 'mori@example.invalid',
    },
  ],
}

describe('provisionGroup', () => {
  it('emits a connection code carrying the pepper and the admin public key', async () => {
    const result = await provisionGroup(options)
    expect(result.code.groupId).toBe('midori')
    expect(result.code.provider).toBe('http')
    expect(result.code.pepper.length).toBeGreaterThan(0)
    expect(result.code.adminPublicKey.length).toBeGreaterThan(0)
  })

  it('writes a manifest, a roster, a keyring and one keystore per member', async () => {
    const result = await provisionGroup(options)
    expect(result.objects.has(manifestPath('midori'))).toBe(true)
    expect(result.objects.has(rosterPath('midori'))).toBe(true)
    expect(result.objects.has(keyringPath('midori', 1))).toBe(true)
    for (const member of options.members) {
      expect(result.objects.has(await keystorePath('midori', member.loginId))).toBe(true)
    }
  })

  it('produces a roster that verifies against the connection code admin key', async () => {
    const result = await provisionGroup(options)
    const file = parseRosterFile(result.objects.get(rosterPath('midori')) as Uint8Array)
    const roster = await verifyRoster(file, fromBase64(result.code.adminPublicKey))
    expect(roster.members.map((m) => m.displayName).sort()).toEqual(
      ['佐藤 さくら', '渡辺 けい', '田中 みか', '森 ゆい'].sort(),
    )
    expect(roster.subgroups.map((s) => s.id).sort()).toEqual(['sg_a', 'sg_a_pickup'])
  })

  it('grants the all scope to everyone and the staff scope only to staff', async () => {
    const result = await provisionGroup(options)
    const file = parseRosterFile(result.objects.get(rosterPath('midori')) as Uint8Array)
    const roster = await verifyRoster(file, fromBase64(result.code.adminPublicKey))
    const byName = (name: string) =>
      roster.members.find((m) => m.displayName === name)?.scopes ?? []
    expect(byName('佐藤 さくら')).toContain(ALL_SCOPE)
    expect(byName('佐藤 さくら')).not.toContain(STAFF_SCOPE)
    expect(byName('田中 みか')).toContain(STAFF_SCOPE)
    expect(byName('渡辺 けい')).toContain(STAFF_SCOPE)
  })

  it('gives a member the all and subgroup keys but not the staff key', async () => {
    const result = await provisionGroup(options)
    const keystore = await unlockKeystore(
      parseKeystoreFile(
        result.objects.get(await keystorePath('midori', 'sato')) as Uint8Array,
      ),
      'member-pass',
      result.code.pepper,
    )
    const keyring = parseKeyringFile(
      result.objects.get(keyringPath('midori', 1)) as Uint8Array,
    )
    const keys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)
    expect([...keys.keys()].sort()).toEqual(['all:v1', 'sg_a:v1'])
  })

  it('gives a nested subgroup member both the child and the parent key', async () => {
    const result = await provisionGroup(options)
    const keystore = await unlockKeystore(
      parseKeystoreFile(
        result.objects.get(await keystorePath('midori', 'mori')) as Uint8Array,
      ),
      'member-pass',
      result.code.pepper,
    )
    const keyring = parseKeyringFile(
      result.objects.get(keyringPath('midori', 1)) as Uint8Array,
    )
    const keys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)
    expect([...keys.keys()].sort()).toEqual(['all:v1', 'sg_a:v1', 'sg_a_pickup:v1'])
  })

  it('does not give a parent subgroup member the child subgroup key', async () => {
    const result = await provisionGroup(options)
    const keystore = await unlockKeystore(
      parseKeystoreFile(
        result.objects.get(await keystorePath('midori', 'sato')) as Uint8Array,
      ),
      'member-pass',
      result.code.pepper,
    )
    const keyring = parseKeyringFile(
      result.objects.get(keyringPath('midori', 1)) as Uint8Array,
    )
    const keys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)
    expect(keys.has('sg_a_pickup:v1')).toBe(false)
  })

  it('rejects a member assigned to an unknown subgroup', async () => {
    const member = options.members.find((m) => m.loginId === 'sato') as NewMember
    await expect(
      provisionGroup({
        ...options,
        members: options.members.map((m) =>
          m.loginId === member.loginId ? { ...m, scopes: ['sg_zzz'] } : m,
        ),
      }),
    ).rejects.toThrow(/sg_zzz/)
  })

  it('lets staff decrypt the contact list while members cannot', async () => {
    const result = await provisionGroup(options)
    const rosterFile = parseRosterFile(result.objects.get(rosterPath('midori')) as Uint8Array)
    const keyring = parseKeyringFile(
      result.objects.get(keyringPath('midori', 1)) as Uint8Array,
    )

    const staff = await unlockKeystore(
      parseKeystoreFile(
        result.objects.get(await keystorePath('midori', 'tanaka')) as Uint8Array,
      ),
      'staff-pass',
      result.code.pepper,
    )
    const staffKeys = await unlockKeyring(keyring, staff.userId, staff.ecdh.privateKey)
    const staffKey = staffKeys.get('staff:v1') as CryptoKey
    const contacts = JSON.parse(
      fromUtf8(
        await openEnvelopeWithKey(staffKey, fromBase64(rosterFile.staffSection as string)),
      ),
    ) as Record<string, { email: string }>
    expect(Object.values(contacts).map((c) => c.email)).toContain('sato@example.invalid')

    const member = await unlockKeystore(
      parseKeystoreFile(
        result.objects.get(await keystorePath('midori', 'sato')) as Uint8Array,
      ),
      'member-pass',
      result.code.pepper,
    )
    const memberKeys = await unlockKeyring(keyring, member.userId, member.ecdh.privateKey)
    expect(memberKeys.has('staff:v1')).toBe(false)
  })

  it('records the keyring generation in the manifest', async () => {
    const result = await provisionGroup(options)
    const manifest = decodeManifest(result.objects.get(manifestPath('midori')) as Uint8Array)
    expect(manifest.keyringGeneration).toBe(1)
    expect(manifest.groupName).toBe('みどり台グループ')
  })

  it('rejects a member set without exactly one admin', async () => {
    await expect(
      provisionGroup({ ...options, members: options.members.filter((m) => m.role !== 'admin') }),
    ).rejects.toThrow(/admin/)
  })

  it('rejects duplicate login ids', async () => {
    const member = options.members.find((member) => member.role === 'member') as NewMember
    await expect(
      provisionGroup({ ...options, members: [...options.members, { ...member }] }),
    ).rejects.toThrow(/duplicate/)
  })

  it('writes every object into a storage provider', async () => {
    const result = await provisionGroup(options)
    const storage = new MemoryStorageProvider()
    await writeObjects(storage, result.objects)
    expect((await storage.list('midori/')).length).toBe(result.objects.size)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/group/provision.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/group/provision"`

- [ ] **Step 3: 実装する**

`src/group/provision.ts`:

```ts
import { generateEcdhKeyPair, generateEcdsaKeyPair } from '../crypto/asymmetric'
import { toBase64, toHex, utf8 } from '../crypto/bytes'
import { sealEnvelope } from '../crypto/envelope'
import type { KdfParams } from '../crypto/kdf'
import { PRODUCTION_KDF } from '../crypto/kdf'
import { createKeystore, serializeKeystoreFile } from '../crypto/keystore'
import type { KeyringEntry, KeyringFile, WrappedKey } from '../crypto/keyring'
import { KEYRING_VERSION, keyId, serializeKeyringFile, wrapKey } from '../crypto/keyring'
import type { Role, RosterMember, Subgroup } from '../crypto/roster'
import { STAFF_SCOPE, resolveScopes, serializeRosterFile, signRoster } from '../crypto/roster'
import { generateAesKey, randomBytes } from '../crypto/symmetric'
import type { StorageProvider } from '../storage/provider'
import { keyringPath, keystorePath, manifestPath, rosterPath } from '../storage/paths'
import type { ConnectionCode, ProviderKind } from './connection-code'
import { CONNECTION_CODE_VERSION } from './connection-code'
import type { Manifest } from './manifest'
import { MANIFEST_VERSION, encodeManifest } from './manifest'

export const INITIAL_GENERATION = 1
export const STAFF_SECTION_KEY_ID = keyId(STAFF_SCOPE, INITIAL_GENERATION)

export class ProvisionError extends Error {}

export interface NewMember {
  loginId: string
  displayName: string
  role: Role
  /** 末端のサブグループ id のみ。all・祖先・staff は resolveScopes が付ける。 */
  scopes: string[]
  password: string
  email: string
}

export interface ProvisionOptions {
  groupId: string
  groupName: string
  provider: ProviderKind
  root: string
  subgroups: Subgroup[]
  members: NewMember[]
  kdf?: KdfParams
}

export interface ProvisionResult {
  code: ConnectionCode
  /** ストレージパス -> 書き込むバイト列 */
  objects: Map<string, Uint8Array>
}

export async function provisionGroup(options: ProvisionOptions): Promise<ProvisionResult> {
  const admins = options.members.filter((member) => member.role === 'admin')
  if (admins.length !== 1) {
    throw new ProvisionError(
      `a group needs exactly one admin, got ${admins.length}`,
    )
  }
  const loginIds = options.members.map((member) => member.loginId.trim().toLowerCase())
  if (new Set(loginIds).size !== loginIds.length) {
    throw new ProvisionError('member list contains duplicate login ids')
  }

  const kdf = options.kdf ?? PRODUCTION_KDF
  const pepper = toBase64(randomBytes(16))
  const objects = new Map<string, Uint8Array>()

  // 1. メンバーごとに鍵ペアと userId を作り、キーストアを封緘する
  const prepared = await Promise.all(
    options.members.map(async (member) => {
      const ecdh = await generateEcdhKeyPair()
      const ecdsa = await generateEcdsaKeyPair()
      const userId = `u_${toHex(randomBytes(8))}`
      return {
        member,
        ecdh,
        ecdsa,
        userId,
        scopes: resolveScopes(options.subgroups, member.role, member.scopes),
      }
    }),
  )

  for (const entry of prepared) {
    const keystore = await createKeystore(
      { userId: entry.userId, ecdh: entry.ecdh, ecdsa: entry.ecdsa },
      entry.member.password,
      pepper,
      kdf,
    )
    objects.set(
      await keystorePath(options.groupId, entry.member.loginId),
      serializeKeystoreFile(keystore),
    )
  }

  // 2. スコープごとにグループ鍵を作り、所属メンバー宛にラップする
  const scopes = [...new Set(prepared.flatMap((entry) => entry.scopes))].sort()
  const groupKeys = new Map<string, CryptoKey>()
  const keyringEntries: Record<string, KeyringEntry> = {}

  for (const scope of scopes) {
    const groupKey = await generateAesKey()
    groupKeys.set(scope, groupKey)
    const wrapped: Record<string, WrappedKey> = {}
    for (const entry of prepared) {
      if (!entry.scopes.includes(scope)) continue
      wrapped[entry.userId] = await wrapKey(entry.ecdh.publicKey, groupKey)
    }
    keyringEntries[keyId(scope, INITIAL_GENERATION)] = {
      scope,
      generation: INITIAL_GENERATION,
      wrapped,
    }
  }

  const keyring: KeyringFile = {
    v: KEYRING_VERSION,
    generation: INITIAL_GENERATION,
    keys: keyringEntries,
  }
  objects.set(
    keyringPath(options.groupId, INITIAL_GENERATION),
    serializeKeyringFile(keyring),
  )

  // 3. 連絡先はstaff スコープ鍵で封緘する(参加者からは復号できない)
  const contacts: Record<string, { email: string }> = {}
  for (const entry of prepared) {
    contacts[entry.userId] = { email: entry.member.email }
  }
  const staffKey = groupKeys.get(STAFF_SCOPE)
  if (!staffKey) {
    throw new ProvisionError('staff scope key was not created')
  }
  const staffSection = await sealEnvelope(
    staffKey,
    STAFF_SECTION_KEY_ID,
    utf8(JSON.stringify(contacts)),
  )

  // 4. 名簿を Admin の ECDSA 鍵で署名する
  const members: RosterMember[] = prepared.map((entry) => ({
    userId: entry.userId,
    displayName: entry.member.displayName,
    role: entry.member.role,
    scopes: entry.scopes,
    ecdhPublic: toBase64(entry.ecdh.publicKey),
    ecdsaPublic: toBase64(entry.ecdsa.publicKey),
  }))
  const adminEntry = prepared.find((entry) => entry.member.role === 'admin')
  if (!adminEntry) {
    throw new ProvisionError('admin entry disappeared during provisioning')
  }
  const rosterFile = await signRoster(
    {
      groupId: options.groupId,
      generation: INITIAL_GENERATION,
      subgroups: options.subgroups,
      members,
    },
    staffSection,
    adminEntry.ecdsa,
  )
  objects.set(rosterPath(options.groupId), serializeRosterFile(rosterFile))

  // 5. manifest(唯一の平文メタデータ)
  const manifest: Manifest = {
    v: MANIFEST_VERSION,
    groupId: options.groupId,
    groupName: options.groupName,
    keyringGeneration: INITIAL_GENERATION,
    rosterGeneration: INITIAL_GENERATION,
    functionUrl: null,
    notificationChannels: ['mailto'],
  }
  objects.set(manifestPath(options.groupId), encodeManifest(manifest))

  return {
    code: {
      v: CONNECTION_CODE_VERSION,
      groupId: options.groupId,
      provider: options.provider,
      root: options.root,
      pepper,
      adminPublicKey: toBase64(adminEntry.ecdsa.publicKey),
    },
    objects,
  }
}

export async function writeObjects(
  storage: StorageProvider,
  objects: Map<string, Uint8Array>,
): Promise<void> {
  for (const [path, data] of objects) {
    await storage.put(path, data)
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/group/provision.test.ts
```

Expected: 13 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/group/provision.ts tests/group/provision.test.ts
git commit -m "feat(group): add group provisioning for the admin flow"
```

---

### Task 14: ログイン処理

**Files:**
- Create: `src/group/session.ts`
- Test: `tests/group/session.test.ts`

**Interfaces:**
- Consumes: Task 7 の `InvalidPasswordError` / `parseKeystoreFile` / `unlockKeystore`、Task 8 の `parseKeyringFile` / `unlockKeyring`、Task 9 の `Role` / `RosterContents` / `parseRosterFile` / `verifyRoster`、Task 10 の `ConnectionCode` / `decodeManifest`、Task 11 の `StorageProvider` / `NotFoundError` とパス関数、Task 13(テストのみ)
- Produces: `class LoginError extends Error`、`interface Session { groupId: string; groupName: string; userId: string; displayName: string; role: Role; scopes: string[]; groupKeys: Map<string, CryptoKey>; roster: RosterContents; ecdhPrivate: Uint8Array; ecdsaPrivate: Uint8Array }`、`login(options: { code: ConnectionCode; loginId: string; password: string; storage: StorageProvider }): Promise<Session>`

このタスクで Phase 1 の目標(接続コード + ID + パスワードでログインし、検証済みのグループ鍵を持つ)が完成する。テストは Task 13 の `provisionGroup` で実物のグループを作り、`MemoryStorageProvider` に書き込んでから端から端まで通す。

アカウントが存在しない場合とパスワードが誤っている場合は、**同一のエラーメッセージ**を返す(在籍者の列挙を防ぐため)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/group/session.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { LoginError, login } from '../../src/group/session'
import { provisionGroup, writeObjects } from '../../src/group/provision'
import type { ProvisionResult } from '../../src/group/provision'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { manifestPath, rosterPath } from '../../src/storage/paths'
import { exportAesKey } from '../../src/crypto/symmetric'
import { utf8 } from '../../src/crypto/bytes'

let provisioned: ProvisionResult
let storage: MemoryStorageProvider

beforeAll(async () => {
  provisioned = await provisionGroup({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    provider: 'http',
    root: 'https://example.invalid/mofune',
    kdf: TEST_KDF,
    subgroups: [{ id: 'sg_a', name: 'Aチーム', parent: null }],
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
        loginId: 'sato',
        displayName: '佐藤 さくら',
        role: 'member',
        scopes: ['sg_a'],
        password: 'member-pass',
        email: 'sato@example.invalid',
      },
    ],
  })
  storage = new MemoryStorageProvider()
  await writeObjects(storage, provisioned.objects)
})

describe('login', () => {
  it('logs a member in and returns their scoped group keys', async () => {
    const session = await login({
      code: provisioned.code,
      loginId: 'sato',
      password: 'member-pass',
      storage,
    })
    expect(session.displayName).toBe('佐藤 さくら')
    expect(session.role).toBe('member')
    expect(session.groupName).toBe('みどり台グループ')
    expect([...session.groupKeys.keys()].sort()).toEqual(['all:v1', 'sg_a:v1'])
    expect(await exportAesKey(session.groupKeys.get('all:v1') as CryptoKey)).toHaveLength(32)
  })

  it('accepts a login id with different case and surrounding spaces', async () => {
    const session = await login({
      code: provisioned.code,
      loginId: '  SATO ',
      password: 'member-pass',
      storage,
    })
    expect(session.displayName).toBe('佐藤 さくら')
  })

  it('gives the admin the staff key as well', async () => {
    const session = await login({
      code: provisioned.code,
      loginId: 'watanabe',
      password: 'admin-pass',
      storage,
    })
    expect(session.role).toBe('admin')
    expect(session.groupKeys.has('staff:v1')).toBe(true)
  })

  it('rejects a wrong password', async () => {
    await expect(
      login({ code: provisioned.code, loginId: 'sato', password: 'wrong', storage }),
    ).rejects.toThrow(LoginError)
  })

  it('reports an unknown login id with the same message as a wrong password', async () => {
    const unknown = (await login({
      code: provisioned.code,
      loginId: 'nobody',
      password: 'member-pass',
      storage,
    }).catch((error: unknown) => error)) as Error
    const wrongPassword = (await login({
      code: provisioned.code,
      loginId: 'sato',
      password: 'wrong',
      storage,
    }).catch((error: unknown) => error)) as Error
    expect(unknown.message).toBe(wrongPassword.message)
  })

  it('refuses a roster signed by a key other than the one in the connection code', async () => {
    const foreign = await provisionGroup({
      groupId: 'midori',
      groupName: 'にせグループ',
      provider: 'http',
      root: 'https://example.invalid/mofune',
      kdf: TEST_KDF,
      subgroups: [],
      members: [
        {
          loginId: 'watanabe',
          displayName: '偽管理者',
          role: 'admin',
          scopes: [],
          password: 'admin-pass',
          email: 'x@example.invalid',
        },
      ],
    })
    const tampered = new MemoryStorageProvider()
    await writeObjects(tampered, provisioned.objects)
    await tampered.put(
      rosterPath('midori'),
      foreign.objects.get(rosterPath('midori')) as Uint8Array,
    )
    await expect(
      login({ code: provisioned.code, loginId: 'sato', password: 'member-pass', storage: tampered }),
    ).rejects.toThrow(LoginError)
  })

  it('refuses a manifest whose group id does not match the connection code', async () => {
    const mismatched = new MemoryStorageProvider()
    await writeObjects(mismatched, provisioned.objects)
    await mismatched.put(
      manifestPath('midori'),
      utf8(
        JSON.stringify({
          v: 1,
          groupId: 'other',
          groupName: 'x',
          keyringGeneration: 1,
          rosterGeneration: 1,
          functionUrl: null,
          notificationChannels: [],
        }),
      ),
    )
    await expect(
      login({
        code: provisioned.code,
        loginId: 'sato',
        password: 'member-pass',
        storage: mismatched,
      }),
    ).rejects.toThrow(/group/)
  })

  it('does not expose the password anywhere on the session', async () => {
    const session = await login({
      code: provisioned.code,
      loginId: 'sato',
      password: 'member-pass',
      storage,
    })
    expect(JSON.stringify(Object.keys(session))).not.toContain('password')
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/group/session.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/group/session"`

- [ ] **Step 3: 実装する**

`src/group/session.ts`:

```ts
import { fromBase64 } from '../crypto/bytes'
import { parseKeyringFile, unlockKeyring } from '../crypto/keyring'
import type { KeystoreContents } from '../crypto/keystore'
import { InvalidPasswordError, parseKeystoreFile, unlockKeystore } from '../crypto/keystore'
import type { Role, RosterContents } from '../crypto/roster'
import { parseRosterFile, verifyRoster } from '../crypto/roster'
import type { StorageProvider } from '../storage/provider'
import { NotFoundError } from '../storage/provider'
import { keyringPath, keystorePath, manifestPath, rosterPath } from '../storage/paths'
import type { ConnectionCode } from './connection-code'
import { decodeManifest } from './manifest'

export class LoginError extends Error {}

/** アカウント不存在とパスワード誤りを区別させないための共通メッセージ。 */
const CREDENTIALS_MESSAGE = 'ログインIDまたはパスワードが正しくありません'

export interface Session {
  groupId: string
  groupName: string
  userId: string
  displayName: string
  role: Role
  scopes: string[]
  /** keyId -> グループ鍵 */
  groupKeys: Map<string, CryptoKey>
  roster: RosterContents
  ecdhPrivate: Uint8Array
  ecdsaPrivate: Uint8Array
}

export interface LoginOptions {
  code: ConnectionCode
  loginId: string
  password: string
  storage: StorageProvider
}

async function loadKeystore(options: LoginOptions): Promise<KeystoreContents> {
  const path = await keystorePath(options.code.groupId, options.loginId)
  let bytes: Uint8Array
  try {
    bytes = await options.storage.get(path)
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new LoginError(CREDENTIALS_MESSAGE)
    }
    throw error
  }
  try {
    return await unlockKeystore(
      parseKeystoreFile(bytes),
      options.password,
      options.code.pepper,
    )
  } catch (error) {
    if (error instanceof InvalidPasswordError) {
      throw new LoginError(CREDENTIALS_MESSAGE)
    }
    throw error
  }
}

export async function login(options: LoginOptions): Promise<Session> {
  const { code, storage } = options

  const manifest = decodeManifest(await storage.get(manifestPath(code.groupId)))
  if (manifest.groupId !== code.groupId) {
    throw new LoginError(
      `manifest group "${manifest.groupId}" does not match the connection code`,
    )
  }

  const keystore = await loadKeystore(options)

  // 名簿は接続コードが運ぶ Admin 公開鍵でのみ検証する。
  let roster: RosterContents
  try {
    roster = await verifyRoster(
      parseRosterFile(await storage.get(rosterPath(code.groupId))),
      fromBase64(code.adminPublicKey),
    )
  } catch (error) {
    throw new LoginError(
      `名簿を検証できませんでした: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const member = roster.members.find((candidate) => candidate.userId === keystore.userId)
  if (!member) {
    throw new LoginError('このアカウントは名簿に登録されていません')
  }

  const keyring = parseKeyringFile(
    await storage.get(keyringPath(code.groupId, manifest.keyringGeneration)),
  )
  const groupKeys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)

  return {
    groupId: code.groupId,
    groupName: manifest.groupName,
    userId: keystore.userId,
    displayName: member.displayName,
    role: member.role,
    scopes: member.scopes,
    groupKeys,
    roster,
    ecdhPrivate: keystore.ecdh.privateKey,
    ecdsaPrivate: keystore.ecdsa.privateKey,
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/group/session.test.ts
```

Expected: 8 tests passed

- [ ] **Step 5: 全テストと型チェックを通す**

```bash
npm run test:run && npm run typecheck
```

Expected: 全テスト green、型エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/group/session.ts tests/group/session.test.ts
git commit -m "feat(group): add password login that unlocks verified group keys"
```

---

### Task 15: 既知グループのレジストリ

**Files:**
- Create: `src/db/groups.ts`
- Test: `tests/db/groups.test.ts`

**Interfaces:**
- Consumes: Task 10 の `ConnectionCode` / `encodeConnectionCode` / `decodeConnectionCode`
- Produces: `interface StoredGroup { groupId: string; groupName: string; code: string; loginId: string; lastLoginAt: number }`、`class GroupRegistryDb extends Dexie`、`rememberGroup(input: { code: ConnectionCode; groupName: string; loginId: string; at: number }): Promise<void>` / `listGroups(): Promise<StoredGroup[]>` / `getGroup(groupId: string): Promise<{ code: ConnectionCode; groupName: string; loginId: string } | undefined>` / `forgetGroup(groupId: string): Promise<void>`

複数グループ切替のために、接続コードとログイン ID だけを端末に保存する。**パスワードと秘密鍵は保存しない**(Global Constraints)。そのため再訪時もパスワード入力は必要で、セッションはメモリ上にしか存在しない。

時刻は引数で受け取る。`Date.now()` を内部で呼ぶとテストが時刻に依存するため。

- [ ] **Step 1: 失敗するテストを書く**

`tests/db/groups.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  registryDb,
  rememberGroup,
  listGroups,
  getGroup,
  forgetGroup,
} from '../../src/db/groups'
import type { ConnectionCode } from '../../src/group/connection-code'

const midori: ConnectionCode = {
  v: 1,
  groupId: 'midori',
  provider: 's3',
  root: 'https://example.invalid/midori',
  pepper: 'cGVwcGVy',
  adminPublicKey: 'BAAA',
}

const aozora: ConnectionCode = { ...midori, groupId: 'aozora', root: 'https://example.invalid/aozora' }

beforeEach(async () => {
  await registryDb.groups.clear()
})

describe('group registry', () => {
  it('remembers a group and reads it back as a decoded connection code', async () => {
    await rememberGroup({ code: midori, groupName: 'みどり台グループ', loginId: 'sato', at: 1000 })
    const stored = await getGroup('midori')
    expect(stored?.code).toEqual(midori)
    expect(stored?.groupName).toBe('みどり台グループ')
    expect(stored?.loginId).toBe('sato')
  })

  it('returns undefined for an unknown group', async () => {
    expect(await getGroup('nope')).toBeUndefined()
  })

  it('lists groups with the most recently used first', async () => {
    await rememberGroup({ code: midori, groupName: 'みどり台', loginId: 'sato', at: 1000 })
    await rememberGroup({ code: aozora, groupName: 'うめ', loginId: 'sato', at: 2000 })
    expect((await listGroups()).map((group) => group.groupId)).toEqual(['aozora', 'midori'])
  })

  it('updates an existing group instead of duplicating it', async () => {
    await rememberGroup({ code: midori, groupName: 'みどり台', loginId: 'sato', at: 1000 })
    await rememberGroup({ code: midori, groupName: 'みどり台グループ', loginId: 'tanaka', at: 3000 })
    const groups = await listGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.groupName).toBe('みどり台グループ')
    expect(groups[0]?.loginId).toBe('tanaka')
  })

  it('forgets a group', async () => {
    await rememberGroup({ code: midori, groupName: 'みどり台', loginId: 'sato', at: 1000 })
    await forgetGroup('midori')
    expect(await listGroups()).toHaveLength(0)
  })

  it('never persists a password field', async () => {
    await rememberGroup({ code: midori, groupName: 'みどり台', loginId: 'sato', at: 1000 })
    const raw = await registryDb.groups.get('midori')
    expect(JSON.stringify(raw)).not.toContain('password')
    expect(Object.keys(raw ?? {}).sort()).toEqual([
      'code',
      'groupId',
      'groupName',
      'lastLoginAt',
      'loginId',
    ])
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/db/groups.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/db/groups"`

- [ ] **Step 3: 実装する**

`src/db/groups.ts`:

```ts
import Dexie from 'dexie'
import type { Table } from 'dexie'
import type { ConnectionCode } from '../group/connection-code'
import { decodeConnectionCode, encodeConnectionCode } from '../group/connection-code'

export interface StoredGroup {
  groupId: string
  groupName: string
  /** 接続コード(base64url)。秘密情報ではない。 */
  code: string
  loginId: string
  lastLoginAt: number
}

export class GroupRegistryDb extends Dexie {
  groups!: Table<StoredGroup, string>

  constructor() {
    super('mofune_registry')
    this.version(1).stores({ groups: 'groupId, lastLoginAt' })
  }
}

export const registryDb = new GroupRegistryDb()

/**
 * 端末に保存するのは接続コードとログイン ID のみ。
 * パスワードと秘密鍵は決して保存しない。
 */
export async function rememberGroup(input: {
  code: ConnectionCode
  groupName: string
  loginId: string
  at: number
}): Promise<void> {
  await registryDb.groups.put({
    groupId: input.code.groupId,
    groupName: input.groupName,
    code: encodeConnectionCode(input.code),
    loginId: input.loginId,
    lastLoginAt: input.at,
  })
}

export async function listGroups(): Promise<StoredGroup[]> {
  return registryDb.groups.orderBy('lastLoginAt').reverse().toArray()
}

export async function getGroup(
  groupId: string,
): Promise<{ code: ConnectionCode; groupName: string; loginId: string } | undefined> {
  const stored = await registryDb.groups.get(groupId)
  if (!stored) return undefined
  return {
    code: decodeConnectionCode(stored.code),
    groupName: stored.groupName,
    loginId: stored.loginId,
  }
}

export async function forgetGroup(groupId: string): Promise<void> {
  await registryDb.groups.delete(groupId)
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

```bash
npx vitest run tests/db/groups.test.ts
```

Expected: 6 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/db/groups.ts tests/db/groups.test.ts
git commit -m "feat(db): add local registry of known groups"
```

---

### Task 16: ログイン画面

**Files:**
- Create: `src/ui/LoginView.vue`
- Modify: `src/App.vue`
- Test: `tests/ui/LoginView.test.ts`

**Interfaces:**
- Consumes: Task 10 の `decodeConnectionCode` / `ConnectionCodeError`、Task 12 の `HttpStorageProvider`、Task 14 の `login` / `LoginError` / `Session`、Task 15 の `rememberGroup` / `listGroups`
- Produces: `LoginView.vue`(props なし、`login` イベントで `Session` を emit)

このテストだけ DOM が必要なため、ファイル先頭に `// @vitest-environment happy-dom` を書く。

`HttpStorageProvider` 以外のプロバイダは Phase 2 以降で実装するため、それ以外が接続コードに指定されていた場合は「このバージョンではまだ対応していない」旨を表示する。

- [ ] **Step 1: 失敗するテストを書く**

`tests/ui/LoginView.test.ts`:

```ts
// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import LoginView from '../../src/ui/LoginView.vue'
import { provisionGroup, writeObjects } from '../../src/group/provision'
import { encodeConnectionCode } from '../../src/group/connection-code'
import { TEST_KDF } from '../../src/crypto/kdf'
import { MemoryStorageProvider } from '../../src/storage/memory'
import { registryDb } from '../../src/db/groups'

async function buildGroup(): Promise<{ code: string; storage: MemoryStorageProvider }> {
  const result = await provisionGroup({
    groupId: 'midori',
    groupName: 'みどり台グループ',
    provider: 'http',
    root: 'https://example.invalid/mofune',
    kdf: TEST_KDF,
    subgroups: [{ id: 'sg_a', name: 'Aチーム', parent: null }],
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
  return { code: encodeConnectionCode(result.code), storage }
}

/** 接続コードの provider が http のとき、fetch をインメモリストレージに向ける。 */
function routeFetchTo(storage: MemoryStorageProvider): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.replace('https://example.invalid/mofune/', '')
      try {
        return new Response(await storage.get(path))
      } catch {
        return new Response('', { status: 404 })
      }
    }),
  )
}

beforeEach(async () => {
  await registryDb.groups.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LoginView', () => {
  it('renders the three input fields', () => {
    const wrapper = mount(LoginView)
    expect(wrapper.find('[data-test="code"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="login-id"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="password"]').exists()).toBe(true)
  })

  it('masks the password field', () => {
    const wrapper = mount(LoginView)
    expect(wrapper.find('[data-test="password"]').attributes('type')).toBe('password')
  })

  it('emits the session after a successful login', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    const wrapper = mount(LoginView)
    await wrapper.find('[data-test="code"]').setValue(code)
    await wrapper.find('[data-test="login-id"]').setValue('watanabe')
    await wrapper.find('[data-test="password"]').setValue('admin-pass')
    await wrapper.find('[data-test="submit"]').trigger('submit')
    await vi.waitFor(() => expect(wrapper.emitted('login')).toBeTruthy())
    const [session] = wrapper.emitted('login')?.[0] as [{ displayName: string }]
    expect(session.displayName).toBe('渡辺 けい')
  })

  it('remembers the group after a successful login', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    const wrapper = mount(LoginView)
    await wrapper.find('[data-test="code"]').setValue(code)
    await wrapper.find('[data-test="login-id"]').setValue('watanabe')
    await wrapper.find('[data-test="password"]').setValue('admin-pass')
    await wrapper.find('[data-test="submit"]').trigger('submit')
    await vi.waitFor(() => expect(wrapper.emitted('login')).toBeTruthy())
    expect(await registryDb.groups.get('midori')).toBeDefined()
  })

  it('shows an error for a malformed connection code', async () => {
    const wrapper = mount(LoginView)
    await wrapper.find('[data-test="code"]').setValue('not-a-code!!')
    await wrapper.find('[data-test="login-id"]').setValue('watanabe')
    await wrapper.find('[data-test="password"]').setValue('admin-pass')
    await wrapper.find('[data-test="submit"]').trigger('submit')
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="error"]').text().length).toBeGreaterThan(0),
    )
    expect(wrapper.emitted('login')).toBeFalsy()
  })

  it('shows an error for a wrong password without emitting a session', async () => {
    const { code, storage } = await buildGroup()
    routeFetchTo(storage)
    const wrapper = mount(LoginView)
    await wrapper.find('[data-test="code"]').setValue(code)
    await wrapper.find('[data-test="login-id"]').setValue('watanabe')
    await wrapper.find('[data-test="password"]').setValue('wrong')
    await wrapper.find('[data-test="submit"]').trigger('submit')
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="error"]').text()).toContain('ログインID'),
    )
    expect(wrapper.emitted('login')).toBeFalsy()
  })

  it('reports unsupported storage providers instead of failing obscurely', async () => {
    const wrapper = mount(LoginView)
    await wrapper.find('[data-test="code"]').setValue(
      encodeConnectionCode({
        v: 1,
        groupId: 'midori',
        provider: 'dropbox',
        root: 'x',
        pepper: 'p',
        adminPublicKey: 'k',
      }),
    )
    await wrapper.find('[data-test="login-id"]').setValue('watanabe')
    await wrapper.find('[data-test="password"]').setValue('admin-pass')
    await wrapper.find('[data-test="submit"]').trigger('submit')
    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="error"]').text()).toContain('dropbox'),
    )
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

```bash
npx vitest run tests/ui/LoginView.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/ui/LoginView.vue"`

- [ ] **Step 3: ログイン画面を実装する**

`src/ui/LoginView.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { ConnectionCodeError, decodeConnectionCode } from '../group/connection-code'
import type { Session } from '../group/session'
import { login } from '../group/session'
import { HttpStorageProvider } from '../storage/http'
import { rememberGroup } from '../db/groups'

const emit = defineEmits<{ login: [session: Session] }>()

const code = ref('')
const loginId = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit(): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    const connection = decodeConnectionCode(code.value)
    if (connection.provider !== 'http') {
      throw new Error(
        `ストレージ "${connection.provider}" はこのバージョンではまだ利用できません`,
      )
    }
    const session = await login({
      code: connection,
      loginId: loginId.value,
      password: password.value,
      storage: new HttpStorageProvider(connection.root),
    })
    await rememberGroup({
      code: connection,
      groupName: session.groupName,
      loginId: loginId.value,
      at: Date.now(),
    })
    password.value = ''
    emit('login', session)
  } catch (caught) {
    error.value =
      caught instanceof ConnectionCodeError
        ? '接続コードを読み取れませんでした。配布された用紙のコードを確認してください'
        : caught instanceof Error
          ? caught.message
          : String(caught)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form data-test="submit" @submit.prevent="submit">
    <h1>Mofune にログイン</h1>

    <label>
      接続コード
      <textarea v-model="code" data-test="code" rows="3" autocomplete="off" />
    </label>

    <label>
      ログインID
      <input v-model="loginId" data-test="login-id" type="text" autocomplete="username" />
    </label>

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

    <button type="submit" :disabled="busy">
      {{ busy ? '確認しています…' : 'ログイン' }}
    </button>
  </form>
</template>
```

- [ ] **Step 4: `App.vue` を差し替える**

`src/App.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import LoginView from './ui/LoginView.vue'
import type { Session } from './group/session'

const session = ref<Session | null>(null)

function onLogin(next: Session): void {
  session.value = next
}
</script>

<template>
  <main>
    <LoginView v-if="!session" @login="onLogin" />
    <section v-else>
      <h1>{{ session.groupName }}</h1>
      <p>{{ session.displayName }} さんとしてログインしています（{{ session.role }}）</p>
      <p>利用できる鍵: {{ [...session.groupKeys.keys()].join(', ') }}</p>
    </section>
  </main>
</template>
```

- [ ] **Step 5: テストを実行して成功を確認する**

```bash
npx vitest run tests/ui/LoginView.test.ts
```

Expected: 7 tests passed

- [ ] **Step 6: 全テストと型チェックを通す**

```bash
npm run test:run && npm run typecheck
```

Expected: 全テスト green、型エラーなし

- [ ] **Step 7: コミット**

```bash
git add src/ui/LoginView.vue src/App.vue tests/ui/LoginView.test.ts
git commit -m "feat(ui): add login screen wired to the crypto foundation"
```

---

## Phase 1 完了条件

- `npm run test:run` が全て green
- `npm run typecheck` がエラーなし
- `npm run dev` で起動し、Task 13 で作った実グループの接続コードでログインでき、グループ名・表示名・保有鍵が表示される

## 次フェーズへの引き継ぎ

このプランで実装していない、Phase 2 以降の作業:

- `S3StorageProvider`(presigned PUT を含む書き込み対応)と `list()` のページング
- inbox(上り経路)、イベントソーシングと同期カーソル
- メッセージ・写真の暗号化保存と表示、`files/` の重複排除
- mailto 通知(BCC・バッチ分割・テンプレート)
- グループ切替 UI と複数グループ横断ダッシュボード(Task 15 のレジストリが土台)
- 鍵ローテーション、退会処理、サブグループ替え
- パスワード変更フロー(キーストアの再封緘。個人鍵は不変のため再ラップ不要)
