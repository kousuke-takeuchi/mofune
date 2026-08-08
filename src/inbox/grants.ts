import type { Bytes } from '../crypto/bytes'
import { fromUtf8, toHex, utf8 } from '../crypto/bytes'
import type { RosterContents } from '../crypto/roster'
import { randomBytes } from '../crypto/symmetric'
import type {
  FunctionStorageSettings,
  S3StorageSettings,
  StorageSettings,
} from '../group/storage-credentials'
import { inboxTicket } from '../storage/function'
import { presignUrl } from '../storage/s3/presign'
import type { StorageProvider } from '../storage/provider'
import { openAsRecipient, sealForRecipients } from './uplink'

export class GrantError extends Error {}

export const GRANT_VERSION = 1
/**
 * 1回の配布で渡す投函枠の数。presigned URL はキーに固定なので1本1回しか使えない。
 * 担当者がアプリを開くたびに配り直すため、数日ぶんあれば足りる。
 */
export const SLOTS_PER_GRANT = 8
/** 枠の有効期限 (秒)。7日。 */
export const GRANT_TTL_SECONDS = 604800

/**
 * 1回ぶんの投函枠。
 *
 * S3 の置き場では presigned URL を渡す。presigned が作れない置き場 (Drive・
 * WebDAV) では、関数が確かめられる引換券を渡す。どちらも「この置き場所へ1つ
 * 置いてよい」という意味しか持たず、合言葉や資格情報は参加者へ渡らない。
 */
export type InboxSlot =
  | {
      /** 古い枠には kind が無い。presigned として読む。 */
      kind?: 'presigned'
      key: string
      url: string
    }
  | {
      kind: 'ticket'
      key: string
      /** 合言葉と置き場所から作った符号。関数が同じ計算で確かめる。 */
      ticket: string
      /** 投函先の関数。 */
      functionUrl: string
    }

export interface InboxGrant {
  v: number
  issuedAt: string
  expiresAt: string
  slots: InboxSlot[]
}

export function grantPath(groupId: string, userId: string): string {
  return `${groupId}/inbox/${userId}/grant.enc`
}

/**
 * 1人ぶんの投函枠を発行し、その人の公開鍵で封緘する。
 * presigned URL は能力トークンなので、平文でストレージに置いてはならない。
 */
export async function issueGrant(options: {
  groupId: string
  userId: string
  ecdhPublic: string
  settings: S3StorageSettings
  now?: Date
}): Promise<{ grant: InboxGrant; sealed: Bytes }> {
  const now = options.now ?? new Date()
  const credentials = {
    accessKeyId: options.settings.accessKeyId,
    secretAccessKey: options.settings.secretAccessKey,
  }

  const slots: InboxSlot[] = []
  for (let i = 0; i < SLOTS_PER_GRANT; i += 1) {
    // キーをランダムにして、誰がいつ何件投函したかを推測しにくくする
    const key = `${options.groupId}/inbox/${options.userId}/${toHex(randomBytes(16))}.enc`
    slots.push({
      kind: 'presigned',
      key,
      url: await presignUrl({
        credentials,
        region: options.settings.region,
        method: 'PUT',
        endpoint: options.settings.endpoint,
        path: `/${options.settings.bucket}/${key}`,
        expiresIn: GRANT_TTL_SECONDS,
        now,
      }),
    })
  }

  const grant: InboxGrant = {
    v: GRANT_VERSION,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + GRANT_TTL_SECONDS * 1000).toISOString(),
    slots,
  }
  const sealed = await sealForRecipients(
    [{ userId: options.userId, ecdhPublic: options.ecdhPublic }],
    utf8(JSON.stringify(grant)),
  )
  return { grant, sealed }
}

/**
 * 関数層を通して投函する枠。presigned URL が作れない置き場で使う。
 *
 * 券は置き場所ごとに違うので、1枚を別の場所へ使い回せない。関数は
 * 合言葉から同じ計算をして確かめるだけで、名簿も鍵も持たない。
 */
export async function issueTicketGrant(options: {
  groupId: string
  userId: string
  ecdhPublic: string
  settings: FunctionStorageSettings
  now?: Date
}): Promise<{ grant: InboxGrant; sealed: Bytes }> {
  const now = options.now ?? new Date()
  const slots: InboxSlot[] = []
  for (let i = 0; i < SLOTS_PER_GRANT; i += 1) {
    const key = `${options.groupId}/inbox/${options.userId}/${toHex(randomBytes(16))}.enc`
    slots.push({
      kind: 'ticket',
      key,
      ticket: await inboxTicket(options.settings.token, key),
      functionUrl: options.settings.functionUrl,
    })
  }

  const grant: InboxGrant = {
    v: GRANT_VERSION,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + GRANT_TTL_SECONDS * 1000).toISOString(),
    slots,
  }
  const sealed = await sealForRecipients(
    [{ userId: options.userId, ecdhPublic: options.ecdhPublic }],
    utf8(JSON.stringify(grant)),
  )
  return { grant, sealed }
}

/**
 * 投函枠を配れる置き場かどうか。
 * WebDAV は、関数に置き場への書き込みを任せない限り配れない。
 */
export function canIssueGrants(
  settings: StorageSettings,
): settings is S3StorageSettings | FunctionStorageSettings {
  return settings.provider === 's3' || settings.provider === 'gdrive'
}

/** 参加者全員ぶんの枠を配る。担当者・管理者は資格情報を持つので配らない。 */
export async function publishGrants(options: {
  storage: StorageProvider
  groupId: string
  roster: RosterContents
  settings: S3StorageSettings | FunctionStorageSettings
  now?: Date
}): Promise<string[]> {
  const issued: string[] = []
  for (const member of options.roster.members) {
    if (member.role !== 'member') continue
    const issue = options.settings.provider === 'gdrive' ? issueTicketGrant : issueGrant
    const { sealed } = await issue({
      groupId: options.groupId,
      userId: member.userId,
      ecdhPublic: member.ecdhPublic,
      // 上の分岐で型は揃っている
      settings: options.settings as never,
      now: options.now,
    })
    await options.storage.put(grantPath(options.groupId, member.userId), sealed)
    issued.push(member.userId)
  }
  return issued
}

export async function readGrant(options: {
  storage: StorageProvider
  groupId: string
  userId: string
  ecdhPrivate: Bytes
}): Promise<InboxGrant> {
  let sealed: Bytes
  try {
    sealed = await options.storage.get(grantPath(options.groupId, options.userId))
  } catch {
    throw new GrantError('no inbox grant has been issued for this user yet')
  }
  const plaintext = await openAsRecipient(options.userId, options.ecdhPrivate, sealed)
  const grant = JSON.parse(fromUtf8(plaintext)) as InboxGrant
  if (grant.v !== GRANT_VERSION || !Array.isArray(grant.slots)) {
    throw new GrantError('inbox grant is malformed')
  }
  return grant
}
