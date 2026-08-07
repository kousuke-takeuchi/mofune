import type { Bytes } from '../crypto/bytes'
export class NotFoundError extends Error {}
export class UnsupportedOperationError extends Error {}
export class InvalidPathError extends Error {}

/**
 * ストレージパスを検証する。URL に連結するプロバイダは必ずこれを通すこと。
 *
 * `new URL()` は ".." を正規化するため、検証しないと `midori/../../../x` のような
 * パスがグループの区画どころかバケットの外へ到達する。接続コードの group_id は
 * 紙で配られる外部入力なので、細工されたコードを信用してはならない。
 */
export function assertSafePath(path: string): void {
  if (path.length === 0) {
    throw new InvalidPathError('storage path must not be empty')
  }
  if (path.startsWith('/')) {
    throw new InvalidPathError(`storage path must be relative, got "${path}"`)
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new InvalidPathError(`storage path has an unsafe segment: "${path}"`)
    }
  }
}

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
  /**
   * prefix 配下を辞書順で返す。after を渡すと、そのパスより後(排他)だけを返す。
   * イベントログの差分同期がこの範囲取得に依存する。
   */
  list(prefix: string, after?: string): Promise<StorageEntry[]>
  delete(path: string): Promise<void>
}
