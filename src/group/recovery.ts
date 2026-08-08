import { fromBase64, toBase64 } from '../crypto/bytes'
import type { KdfParams } from '../crypto/kdf'
import { PRODUCTION_KDF } from '../crypto/kdf'
import { unlockKeyring, parseKeyringFile } from '../crypto/keyring'
import { createKeystore, serializeKeystoreFile } from '../crypto/keystore'
import { S3StorageProvider } from '../storage/s3'
import type { StorageProvider } from '../storage/provider'
import { keyringPath, keystorePath, manifestPath } from '../storage/paths'
import { decodeManifest } from './manifest'
import type { ConnectionCode } from './connection-code'
import { normalizeEmail } from './email-id'
import { RecoveryKitError, parseRecoveryKit } from './recovery-kit'
import type { StorageSettings } from './storage-credentials'
import { readStorageSettings, toProviderConfig } from './storage-credentials'

export class RecoveryError extends Error {}

/**
 * 紙のリカバリキットから管理者のログインを作り直す。
 *
 * 紙にあるのはルート鍵そのものなので、パスワードを覚えていなくても、
 * 新しいパスワードでキーストアを作り直せば入り直せる。グループ鍵は
 * 鍵束のほうに入ったままなので、過去のお知らせもそのまま読める。
 *
 * 書き込みには保管場所の資格情報が要る。それは staff スコープで封緘されて
 * いるので、紙の ECDH 秘密鍵で鍵束を開けてから読む。
 */
export async function restoreFromRecoveryKit(options: {
  storage: StorageProvider
  code: ConnectionCode
  /** 紙に印刷された復元コード。 */
  text: string
  /** これからログインに使うメールアドレス。 */
  email: string
  password: string
  kdf?: KdfParams
  /** 資格情報から書き込み用プロバイダを作る。差し替えるのはテストだけ。 */
  createWriter?: (settings: StorageSettings) => StorageProvider
}): Promise<{ groupId: string; groupName: string; userId: string; email: string }> {
  const email = (() => {
    try {
      return normalizeEmail(options.email)
    } catch {
      throw new RecoveryError('メールアドレスを正しく入れてください')
    }
  })()

  let kit
  try {
    kit = await parseRecoveryKit(options.text)
  } catch (cause) {
    if (cause instanceof RecoveryKitError) {
      throw new RecoveryError('復元コードを読み取れませんでした。書き写しをご確認ください')
    }
    throw cause
  }

  if (kit.groupId !== options.code.groupId) {
    throw new RecoveryError('この復元コードは、いまの接続コードのグループのものではありません')
  }
  // 名簿の信頼の根と一致しない紙で作り直すと、以後の再署名が誰にも検証されない
  if (toBase64(kit.contents.ecdsa.publicKey) !== options.code.adminPublicKey) {
    throw new RecoveryError('この復元コードは、いまの接続コードのグループのものではありません')
  }

  // 鍵束は世代ごとに置いてある。いまの世代は manifest が持つ
  const manifest = decodeManifest(await options.storage.get(manifestPath(options.code.groupId)))
  const keys = await unlockKeyring(
    parseKeyringFile(
      await options.storage.get(keyringPath(options.code.groupId, manifest.keyringGeneration)),
    ),
    kit.userId,
    kit.contents.ecdh.privateKey,
  )
  if (keys.size === 0) {
    throw new RecoveryError('この復元コードでは鍵束を開けませんでした')
  }

  let settings: StorageSettings
  try {
    settings = await readStorageSettings({
      storage: options.storage,
      groupId: options.code.groupId,
      keys,
    })
  } catch {
    throw new RecoveryError('保管場所の資格情報を読み取れませんでした')
  }

  const writer = options.createWriter
    ? options.createWriter(settings)
    : new S3StorageProvider(toProviderConfig(settings))

  const file = await createKeystore(
    kit.contents,
    options.password,
    options.code.pepper,
    options.kdf ?? PRODUCTION_KDF,
  )
  await writer.put(await keystorePath(options.code.groupId, email), serializeKeystoreFile(file))

  return { groupId: options.code.groupId, groupName: kit.groupName, userId: kit.userId, email }
}

/** 紙が本物かどうかだけを確かめる。画面で「読めました」を出すために使う。 */
export async function inspectRecoveryKit(
  text: string,
): Promise<{ groupId: string; userId: string; adminPublicKey: string }> {
  try {
    const kit = await parseRecoveryKit(text)
    return {
      groupId: kit.groupId,
      userId: kit.userId,
      adminPublicKey: toBase64(kit.contents.ecdsa.publicKey),
    }
  } catch {
    throw new RecoveryError('復元コードを読み取れませんでした。書き写しをご確認ください')
  }
}

/** 接続コードが運ぶ Admin 公開鍵。表示のために生バイトへ戻す。 */
export function adminPublicKeyBytes(code: ConnectionCode) {
  return fromBase64(code.adminPublicKey)
}
