import type { Bytes } from '../crypto/bytes'
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
  get(path: string): Promise<Bytes>
  put(path: string, data: Bytes): Promise<void>
  list(prefix: string): Promise<StorageEntry[]>
  delete(path: string): Promise<void>
}
