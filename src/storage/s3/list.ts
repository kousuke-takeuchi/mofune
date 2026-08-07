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
