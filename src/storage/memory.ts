import type { Bytes } from '../crypto/bytes'
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

  private readonly objects: Map<string, Bytes>

  constructor(seed?: Map<string, Bytes>) {
    this.objects = new Map()
    if (seed) {
      for (const [path, data] of seed) {
        this.objects.set(path, Uint8Array.from(data))
      }
    }
  }

  async get(path: string): Promise<Bytes> {
    const data = this.objects.get(path)
    if (!data) throw new NotFoundError(`no object at "${path}"`)
    return Uint8Array.from(data)
  }

  async put(path: string, data: Bytes): Promise<void> {
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
