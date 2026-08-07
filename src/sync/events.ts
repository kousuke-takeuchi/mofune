import type { Bytes } from '../crypto/bytes'
import { fromUtf8, toHex, utf8 } from '../crypto/bytes'
import type { SealTarget } from '../crypto/envelope'
import { openEnvelope, sealEnvelopeFor } from '../crypto/envelope'
import { randomBytes } from '../crypto/symmetric'

export class EventFormatError extends Error {}

export type EventType =
  | 'MESSAGE_CREATED'
  | 'FILE_ADDED'
  | 'MEMBER_UPDATED'
  | 'ABSENCE_REPORTED'

export interface GroupEvent {
  /** `{ISO8601基本形式}-{ランダム8桁hex}`。辞書順=時系列順。 */
  id: string
  type: EventType
  author: string
  /** ISO 8601 拡張形式。 */
  at: string
  payload: Record<string, unknown>
}

const EVENT_TYPES: readonly string[] = [
  'MESSAGE_CREATED',
  'FILE_ADDED',
  'MEMBER_UPDATED',
  'ABSENCE_REPORTED',
]

/**
 * 時系列にソートできる ID。同一時刻の衝突はランダム部で避ける。
 * ストレージの一覧は辞書順で返るため、この形式がそのままカーソルになる。
 */
export function newEventId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return `${stamp}-${toHex(randomBytes(4))}`
}

export function eventPathFor(groupId: string, id: string): string {
  return `${groupId}/events/${id}.enc`
}

export function compareEventIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export async function sealEvent(event: GroupEvent, targets: SealTarget[]): Promise<Bytes> {
  return sealEnvelopeFor(targets, utf8(JSON.stringify(event)))
}

export async function openEvent(
  keys: ReadonlyMap<string, CryptoKey>,
  bytes: Bytes,
): Promise<GroupEvent> {
  const plaintext = await openEnvelope(keys, bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(plaintext))
  } catch {
    throw new EventFormatError('event body is not valid JSON')
  }
  const event = parsed as GroupEvent
  if (event === null || typeof event !== 'object') {
    throw new EventFormatError('event body is not an object')
  }
  if (typeof event.id !== 'string' || typeof event.author !== 'string') {
    throw new EventFormatError('event is missing required fields')
  }
  if (!EVENT_TYPES.includes(event.type)) {
    throw new EventFormatError(`unknown event type ${String(event.type)}`)
  }
  return event
}
