import type { Bytes } from '../crypto/bytes'
import { fromBase64 } from '../crypto/bytes'
import type { KdfParams } from '../crypto/kdf'
import { keyId, parseKeyringFile, unlockKeyring } from '../crypto/keyring'
import { parseKeystoreFile, unlockKeystore } from '../crypto/keystore'
import type { Subgroup } from '../crypto/roster'
import { STAFF_SCOPE, parseRosterFile, verifyRoster } from '../crypto/roster'
import { publishGrants } from '../inbox/grants'
import { keyringPath, keystorePath, rosterPath } from '../storage/paths'
import type { StorageProvider } from '../storage/provider'
import type { ConnectionCode } from './connection-code'
import { encodeConnectionCode } from './connection-code'
import type { CheckResult } from './connection-check'
import { checkConnection } from './connection-check'
import { DEFAULT_GROUP_SETTINGS, writeGroupSettings } from './group-settings'
import type { NewMember } from './provision'
import { INITIAL_GENERATION, provisionGroup, writeObjects } from './provision'
import type { RecoveryKit } from './recovery-kit'
import { buildRecoveryKit } from './recovery-kit'
import type { StorageSettings } from './storage-credentials'
import { writeStorageSettings } from './storage-credentials'

export class SetupError extends Error {
  /**
   * 接続確認で止まった場合の全段。どこまで通ってどこで落ちたかを画面に出せないと、
   * 利用者は直しようがない。
   */
  readonly check: CheckResult | undefined

  constructor(message: string, check?: CheckResult) {
    super(message)
    this.check = check
  }
}

export interface SetupOptions {
  groupId: string
  groupName: string
  adminDisplayName: string
  adminPassword: string
  adminEmail: string
  settings: StorageSettings
  storage: StorageProvider
  subgroups?: Subgroup[]
  members?: NewMember[]
  kdf?: KdfParams
}

export interface SetupResult {
  code: ConnectionCode
  connectionCode: string
  recoveryKit: RecoveryKit
  check: CheckResult
  grantsIssued: string[]
}

function take(objects: Map<string, Bytes>, path: string): Bytes {
  const bytes = objects.get(path)
  if (!bytes) {
    throw new SetupError(`provisioning did not produce "${path}"`)
  }
  return bytes
}

/**
 * 開設の一連の流れ。順序が本質なので画面ではなくここに置く。
 *
 * 接続確認に失敗したら何も書かない。途中まで書いたグループが残ると、
 * 中途半端な状態がストレージに残り続ける。
 */
export async function setUpGroup(options: SetupOptions): Promise<SetupResult> {
  const check = await checkConnection({
    storage: options.storage,
    groupId: options.groupId,
    publicBaseUrl: options.settings.publicBaseUrl,
  })
  if (!check.ok) {
    const failed = check.steps.find((step) => !step.ok)
    throw new SetupError(failed?.detail ?? 'ストレージの接続確認に失敗しました', check)
  }

  const admin: NewMember = {
    displayName: options.adminDisplayName,
    role: 'admin',
    scopes: [],
    password: options.adminPassword,
    email: options.adminEmail,
  }
  const provisioned = await provisionGroup({
    groupId: options.groupId,
    groupName: options.groupName,
    provider: options.settings.provider,
    // root は参加者が素の GET で読む起点。S3 の API エンドポイントを入れてはならない。
    root: options.settings.publicBaseUrl.replace(/\/+$/, ''),
    subgroups: options.subgroups ?? [],
    members: [admin, ...(options.members ?? [])],
    ...(options.kdf ? { kdf: options.kdf } : {}),
  })
  await writeObjects(options.storage, provisioned.objects)

  // 管理者のキーストアを解いて staff スコープ鍵とルート鍵を取り出す
  const keystore = await unlockKeystore(
    parseKeystoreFile(
      take(provisioned.objects, await keystorePath(options.groupId, options.adminEmail)),
    ),
    options.adminPassword,
    provisioned.code.pepper,
  )
  const keyring = parseKeyringFile(
    take(provisioned.objects, keyringPath(options.groupId, INITIAL_GENERATION)),
  )
  const keys = await unlockKeyring(keyring, keystore.userId, keystore.ecdh.privateKey)
  const staffKey = keys.get(keyId(STAFF_SCOPE, INITIAL_GENERATION))
  if (!staffKey) {
    throw new SetupError('the staff scope key was not created')
  }

  await writeStorageSettings({
    storage: options.storage,
    groupId: options.groupId,
    settings: options.settings,
    staffKey,
    generation: INITIAL_GENERATION,
  })
  await writeGroupSettings({
    storage: options.storage,
    groupId: options.groupId,
    settings: DEFAULT_GROUP_SETTINGS,
    staffKey,
    generation: INITIAL_GENERATION,
  })

  // 投函枠は署名済み名簿の実物から配る。provisionGroup が採番した userId と
  // 公開鍵でなければ、参加者は自分の grant を復号できない。
  const roster = await verifyRoster(
    parseRosterFile(take(provisioned.objects, rosterPath(options.groupId))),
    fromBase64(provisioned.code.adminPublicKey),
  )
  const grantsIssued =
    options.settings.provider === 's3'
      ? await publishGrants({
          storage: options.storage,
          groupId: options.groupId,
          roster,
          settings: options.settings,
        })
      : []

  // リカバリキットは戻り値に必ず含める。あとで出す導線にすると
  // 出さないまま運用が始まり、ルート鍵を失った時点で詰む(設計書 §4.8)。
  const recoveryKit = await buildRecoveryKit({
    groupId: options.groupId,
    groupName: options.groupName,
    contents: keystore,
  })

  return {
    code: provisioned.code,
    connectionCode: encodeConnectionCode(provisioned.code),
    recoveryKit,
    check,
    grantsIssued,
  }
}
