import { fromUtf8, utf8 } from '../crypto/bytes'
import { NotFoundError } from '../storage/provider'
import type { StorageProvider } from '../storage/provider'

/**
 * イベントの索引。
 *
 * 差分同期はもともと `list` に頼っていたが、参加者が使う公開読みの経路は
 * 一覧を返せない(R2 の公開URLも Google Drive も同じ)。索引が無いと参加者は
 * 1件も取得できないため、書ける側が「いま何があるか」を平文の一覧として置く。
 *
 * 中身はイベント ID だけで、本文は含まない。ファイル名は元々公開メタデータ
 * (要件書 §5.3 の許容メタデータ)なので、これで漏れる情報は増えない。
 */
export function eventIndexPath(groupId: string): string {
  // events/ の中には置かない。イベントを数える処理が索引まで数えてしまう。
  return `${groupId}/events-index.json`
}

interface EventIndexFile {
  v: number
  ids: string[]
}

const EVENT_INDEX_VERSION = 1

/** ストレージパスからイベント ID を取り出す。 */
function idFromPath(path: string): string {
  return (path.split('/').pop() ?? '').replace(/\.enc$/, '')
}

/**
 * 実物から索引を作り直す。追記ではなく作り直すのは、複数の担当者が同時に
 * 投稿したときに索引が壊れても、次の書き込みで真実へ戻すため。
 */
export async function rebuildEventIndex(options: {
  storage: StorageProvider
  groupId: string
}): Promise<string[]> {
  const entries = await options.storage.list(`${options.groupId}/events/`)
  const ids = entries
    .map((entry) => idFromPath(entry.path))
    .sort()
  const file: EventIndexFile = { v: EVENT_INDEX_VERSION, ids }
  await options.storage.put(eventIndexPath(options.groupId), utf8(JSON.stringify(file)))
  return ids
}

/**
 * イベント ID を並べる。一覧できるプロバイダなら実物から、できないなら索引から。
 * 索引がまだ無いグループでは空を返す。読めないことと空であることを、
 * 参加者に区別させても仕方がない。
 */
export async function listEventIds(options: {
  storage: StorageProvider
  groupId: string
}): Promise<string[]> {
  if (options.storage.capabilities.list) {
    const entries = await options.storage.list(`${options.groupId}/events/`)
    return entries.map((entry) => idFromPath(entry.path)).sort()
  }

  let raw
  try {
    raw = await options.storage.get(eventIndexPath(options.groupId))
  } catch (cause) {
    // 索引がまだ無いだけなら空。通信できていないなら、それは黙って隠さない。
    if (cause instanceof NotFoundError) return []
    throw cause
  }
  try {
    const file = JSON.parse(fromUtf8(raw)) as EventIndexFile
    if (file.v !== EVENT_INDEX_VERSION || !Array.isArray(file.ids)) return []
    return [...file.ids].sort()
  } catch {
    return []
  }
}
