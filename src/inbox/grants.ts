import type { Bytes } from '../crypto/bytes'
import { fromUtf8, toHex, utf8 } from '../crypto/bytes'
import type { RosterContents } from '../crypto/roster'
import { randomBytes } from '../crypto/symmetric'
import type { S3StorageSettings } from '../group/storage-credentials'
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

export interface InboxSlot {
  /** 投函先のオブジェクトキー */
  key: string
  /** そのキーへの PUT を許す presigned URL */
  url: string
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

/** 参加者全員ぶんの枠を配る。担当者・管理者は資格情報を持つので配らない。 */
/**
 * 投函枠を配れる置き場かどうか。presigned URL を作れるのは S3 互換だけで、
 * WebDAV や Drive では関数層の引換券に頼る。
 */
export function canIssueGrants(settings: { provider: string }): boolean {
  return settings.provider === 's3'
}

export async function publishGrants(options: {
  storage: StorageProvider
  groupId: string
  roster: RosterContents
  settings: S3StorageSettings
  now?: Date
}): Promise<string[]> {
  const issued: string[] = []
  for (const member of options.roster.members) {
    if (member.role !== 'member') continue
    const { sealed } = await issueGrant({
      groupId: options.groupId,
      userId: member.userId,
      ecdhPublic: member.ecdhPublic,
      settings: options.settings,
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
