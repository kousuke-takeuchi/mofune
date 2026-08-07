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
