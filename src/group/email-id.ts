export class EmailError extends Error {}

/**
 * メールアドレスはログインの識別子でもある。
 *
 * キーストアの置き場所は SHA-256(groupId + このアドレス) で決まるので、
 * 大小や前後の空白が揺れると本人でも入れなくなる。入口で必ず通す。
 */
export function normalizeEmail(input: string): string {
  const value = input.trim().toLowerCase()
  if (value.length === 0) {
    throw new EmailError('メールアドレスを入れてください')
  }
  // 厳密な検証はしない。ここで弾きたいのは打ち間違いであって、RFC の隅ではない。
  if (!/^[^\s@]+@[^\s@]+$/.test(value)) {
    throw new EmailError('メールアドレスの形になっていません')
  }
  return value
}
