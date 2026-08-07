import Dexie from 'dexie'
import type { Table } from 'dexie'
import type { Bytes } from '../crypto/bytes'
import type { RosterContents } from '../crypto/roster'
import type { GroupEvent } from '../sync/events'

export interface CachedMessage {
  id: string
  scopes: string[]
  author: string
  at: string
  body: string
  /** files/ に置かれた添付の id。 */
  attachments: string[]
}

export interface CachedFile {
  id: string
  mediaType: string
  size: number
  blob: Bytes
  cachedAt: string
}

export interface CachedRoster {
  groupId: string
  contents: RosterContents
}

export interface OutboxItem {
  id: string
  kind: 'event' | 'inbox'
  /** 送信先のストレージパス、または presigned URL。 */
  path: string
  body: Bytes
  queuedAt: string
  attempts: number
}

export interface SyncState {
  key: 'cursor' | 'lastReadAt'
  value: string | null
}

export class GroupDatabase extends Dexie {
  messages!: Table<CachedMessage, string>
  files!: Table<CachedFile, string>
  events!: Table<GroupEvent, string>
  roster!: Table<CachedRoster, string>
  outbox!: Table<OutboxItem, string>
  syncState!: Table<SyncState, string>

  constructor(groupId: string) {
    super(`mofune_${groupId}`)
    this.version(1).stores({
      messages: 'id, at',
      files: 'id, cachedAt',
      events: 'id',
      roster: 'groupId',
      outbox: 'id, queuedAt',
      syncState: 'key',
    })
  }
}

const open = new Map<string, GroupDatabase>()

/** グループごとに1インスタンスを使い回す。IndexedDB は名前で分離される。 */
export function openGroupDatabase(groupId: string): GroupDatabase {
  const existing = open.get(groupId)
  if (existing) return existing
  const db = new GroupDatabase(groupId)
  open.set(groupId, db)
  return db
}

export async function closeGroupDatabase(groupId: string): Promise<void> {
  const db = open.get(groupId)
  if (!db) return
  db.close()
  open.delete(groupId)
}

/** 設計書 §5.4「この端末の登録を解除」で使う。復号済みキャッシュを消す。 */
export async function deleteGroupDatabase(groupId: string): Promise<void> {
  await closeGroupDatabase(groupId)
  await Dexie.delete(`mofune_${groupId}`)
}
