import type { Bytes } from '../crypto/bytes'
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

  async get(path: string): Promise<Bytes> {
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

  async put(_path: string, _data: Bytes): Promise<void> {
    throw new UnsupportedOperationError('HttpStorageProvider is read-only')
  }

  async list(_prefix: string): Promise<StorageEntry[]> {
    throw new UnsupportedOperationError('HttpStorageProvider cannot list objects')
  }

  async delete(_path: string): Promise<void> {
    throw new UnsupportedOperationError('HttpStorageProvider is read-only')
  }
}
