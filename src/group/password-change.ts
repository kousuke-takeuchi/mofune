import type { Bytes } from '../crypto/bytes'
import { fromBase64, fromUtf8, utf8 } from '../crypto/bytes'
import type { KdfParams } from '../crypto/kdf'
import { PRODUCTION_KDF } from '../crypto/kdf'
import { createKeystore, serializeKeystoreFile } from '../crypto/keystore'
import type { KeystoreContents } from '../crypto/keystore'
import type { StorageProvider } from '../storage/provider'
import { keystorePath } from '../storage/paths'
import { normalizeEmail } from './email-id'
import type { Session } from './session'

export class PasswordChangeError extends Error {}

export const PASSWORD_CHANGE_VERSION = 1
/** これより短いものは、変えても意味が薄い。 */
const MIN_PASSWORD_LENGTH = 8

/**
 * 参加者が自分でパスワードを変える。
 *
 * 参加者は置き場へ書けないので、**新しいキーストアを作って受信箱へ投函し**、
 * 担当者が受け取って置き場へ移す。キーストアはもともと公開読みの場所に
 * 置かれている暗号化済みのファイルなので、この経路で中身が余計に漏れることはない。
 *
 * 鍵は作り直さない。作り直すと過去のお知らせが読めなくなる (管理者による
 * 再発行はそちらの方式で、こちらは「同じ鍵を別のパスワードで包み直す」だけ)。
 */
export interface PasswordChange {
  v: number
  kind: 'password-change'
  userId: string
  /** どこに置くかを決めるアドレス。 */
  email: string
  /** 新しいパスワードで包み直したキーストア (JSON)。 */
  keystore: string
  at: string
}

export async function buildPasswordChange(options: {
  session: Session
  email: string
  newPassword: string
  /** 接続コードが運ぶ pepper。キーストアの鍵導出に混ぜる。 */
  pepper: string
  kdf?: KdfParams
  now?: Date
}): Promise<PasswordChange> {
  if (options.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordChangeError(
      `パスワードは${String(MIN_PASSWORD_LENGTH)}文字以上にしてください`,
    )
  }
  let email: string
  try {
    email = normalizeEmail(options.email)
  } catch {
    throw new PasswordChangeError('メールアドレスを正しく入れてください')
  }

  // 公開鍵は名簿にある。セッションは秘密鍵しか持たない
  const me = options.session.roster.members.find(
    (member) => member.userId === options.session.userId,
  )
  if (!me) {
    throw new PasswordChangeError('自分が名簿にいません')
  }

  const contents: KeystoreContents = {
    userId: options.session.userId,
    // いま使っている鍵をそのまま包み直す。作り直すと過去のお知らせが読めなくなる
    ecdh: { publicKey: fromBase64(me.ecdhPublic), privateKey: options.session.ecdhPrivate },
    ecdsa: { publicKey: fromBase64(me.ecdsaPublic), privateKey: options.session.ecdsaPrivate },
  }
  const file = await createKeystore(
    contents,
    options.newPassword,
    options.pepper,
    options.kdf ?? PRODUCTION_KDF,
  )

  return {
    v: PASSWORD_CHANGE_VERSION,
    kind: 'password-change',
    userId: options.session.userId,
    email,
    keystore: fromUtf8(serializeKeystoreFile(file)),
    at: (options.now ?? new Date()).toISOString(),
  }
}

export function parsePasswordChange(bytes: Bytes): PasswordChange {
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(bytes))
  } catch {
    throw new PasswordChangeError('password change is not valid JSON')
  }
  const change = parsed as PasswordChange
  if (
    change === null ||
    typeof change !== 'object' ||
    change.v !== PASSWORD_CHANGE_VERSION ||
    change.kind !== 'password-change' ||
    typeof change.userId !== 'string' ||
    typeof change.email !== 'string' ||
    typeof change.keystore !== 'string'
  ) {
    throw new PasswordChangeError('password change is missing required fields')
  }
  return change
}

/**
 * 届いた変更を置き場へ移す。
 *
 * 名乗った userId と、投函されていた場所の userId が一致しなければ断る。
 * 受信箱の置き場所は本人ぶんしか配られないので、これが本人確認になる。
 */
export async function applyPasswordChange(options: {
  storage: StorageProvider
  groupId: string
  change: PasswordChange
  /** 投函物が置かれていた受信箱の持ち主。 */
  userId: string
}): Promise<void> {
  if (options.change.userId !== options.userId) {
    throw new PasswordChangeError('この変更は投函した人のものではありません')
  }
  await options.storage.put(
    await keystorePath(options.groupId, options.change.email),
    utf8(options.change.keystore),
  )
}
