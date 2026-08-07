import type { Bytes } from './bytes'
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

/** 本番用。モバイル実機での所要時間は設計書 §16 の検証課題。 */
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
  salt: Bytes,
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
  })) as Bytes
  return importAesKey(raw)
}
