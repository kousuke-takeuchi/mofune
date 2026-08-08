import type { Bytes } from '../crypto/bytes'
import type { GroupDatabase } from '../db/group-db'
import type { StorageProvider } from '../storage/provider'
import { compareEventIds, openEvent } from './events'
import { listEventIds, rebuildEventIndex } from './event-index'
import { projectEvent } from './projection'

export interface SyncResult {
  /** 復号して適用できたイベント数。 */
  applied: number
  /** 自分の鍵では開けなかったイベント数(正常系)。 */
  skipped: number
  /** 参照先が未着で投影できなかった数。次回の同期で再投影される。 */
  missing: number
  cursor: string | null
}

export async function readCursor(db: GroupDatabase): Promise<string | null> {
  return (await db.syncState.get('cursor'))?.value ?? null
}

export async function writeCursor(db: GroupDatabase, cursor: string): Promise<void> {
  await db.syncState.put({ key: 'cursor', value: cursor })
}

/** 最後に同期を終えた時刻 (ISO)。まだ一度も同期していなければ null。 */
export async function readLastSyncedAt(db: GroupDatabase): Promise<string | null> {
  return (await db.syncState.get('lastSyncedAt'))?.value ?? null
}

/** 同時に走らせる本数。増やしても回線と相手側の上限で止まる。 */
const FETCH_CONCURRENCY = 4

/**
 * まとめて取りに行き、頼んだ順に並べて返す。取れなかったものは null。
 * 例外にしないのは、1件の欠けで残りを捨てないため。
 */
async function fetchInOrder(
  ids: string[],
  fetch: (id: string) => Promise<Bytes>,
): Promise<Array<{ id: string; sealed: Bytes | null }>> {
  const results: Array<{ id: string; sealed: Bytes | null }> = []
  for (let start = 0; start < ids.length; start += FETCH_CONCURRENCY) {
    const batch = ids.slice(start, start + FETCH_CONCURRENCY)
    const settled = await Promise.all(
      batch.map(async (id) => {
        try {
          return { id, sealed: await fetch(id) }
        } catch {
          return { id, sealed: null }
        }
      }),
    )
    results.push(...settled)
  }
  return results
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
  // 参加者の経路は一覧を返せないので、索引から取る (event-index.ts)
  const all = await listEventIds({
    storage: options.storage,
    groupId: options.groupId,
    ...(cursor === null ? {} : { after: cursor }),
  })
  const ids = all
    .filter((id) => cursor === null || compareEventIds(id, cursor) > 0)
    .sort(compareEventIds)
  let applied = 0
  let skipped = 0
  let missing = 0
  let lastDone: string | null = null

  /*
   * 本文の取得はまとめて走らせる。1件ずつ待つと、往復の回数ぶん待たされる
   * (初回の同期がとくに遅い)。ただし**適用は並びどおり**に行う。順番が崩れると、
   * 同じものを2度書いたり、カーソルの意味が壊れたりする。
   */
  const fetched = await fetchInOrder(ids, (id) => options.storage.get(`${prefix}${id}.enc`))

  for (const { id, sealed } of fetched) {
    if (sealed === null) {
      // 取れなかったものは次の同期で拾う。カーソルはここで止める
      break
    }
    try {
      const event = await openEvent(options.keys, sealed)
      await options.db.events.put(event)
      const projected = await projectEvent({
        db: options.db,
        storage: options.storage,
        groupId: options.groupId,
        keys: options.keys,
        event,
      })
      missing += projected.missing
      applied += 1
    } catch {
      skipped += 1
    }
    lastDone = id
  }

  const newest = lastDone
  if (newest !== null) {
    await writeCursor(options.db, newest)
  }
  // 一覧できる側 (担当者・管理者) は、参加者のための索引を最新にしておく。
  // 参加者はこれが無いと1件も取得できない。
  if (options.storage.capabilities.list && options.storage.capabilities.write) {
    try {
      await rebuildEventIndex({ storage: options.storage, groupId: options.groupId })
    } catch {
      // 索引の更新に失敗しても同期そのものは成立している
    }
  }

  // 新着が無かった同期も記録する。「いつ確かめたか」が利用者の知りたいことで、
  // 「いつ届いたか」ではない。
  await options.db.syncState.put({ key: 'lastSyncedAt', value: new Date().toISOString() })
  return { applied, skipped, missing, cursor: newest ?? cursor }
}
