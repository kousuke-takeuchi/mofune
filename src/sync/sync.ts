import type { GroupDatabase } from '../db/group-db'
import type { StorageProvider } from '../storage/provider'
import { compareEventIds, openEvent } from './events'
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

/** ストレージパスからイベント ID を取り出す。 */
function idFromPath(path: string): string {
  return (path.split('/').pop() ?? '').replace(/\.enc$/, '')
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
  const after = cursor ? `${prefix}${cursor}.enc` : undefined
  const entries = await options.storage.list(prefix, after)

  const ids = entries.map((entry) => idFromPath(entry.path)).sort(compareEventIds)
  let applied = 0
  let skipped = 0
  let missing = 0

  for (const id of ids) {
    const sealed = await options.storage.get(`${prefix}${id}.enc`)
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
  }

  const newest = ids.length > 0 ? (ids[ids.length - 1] as string) : null
  if (newest !== null) {
    await writeCursor(options.db, newest)
  }
  // 新着が無かった同期も記録する。「いつ確かめたか」が利用者の知りたいことで、
  // 「いつ届いたか」ではない。
  await options.db.syncState.put({ key: 'lastSyncedAt', value: new Date().toISOString() })
  return { applied, skipped, missing, cursor: newest ?? cursor }
}
