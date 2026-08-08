import { toHex, utf8 } from '../crypto/bytes'
import { sha256 } from '../crypto/symmetric'

export function manifestPath(groupId: string): string {
  return `${groupId}/manifest.json`
}

export function rosterPath(groupId: string): string {
  return `${groupId}/roster.sig.json`
}

export function keyringPath(groupId: string, generation: number): string {
  return `${groupId}/keyring/v${String(generation).padStart(3, '0')}.json`
}

/**
 * ログインの識別子はメールアドレス。そのままパスに出すと、公開ストレージ上で
 * 在籍者のアドレスを列挙できてしまうのでハッシュしてから配置する。
 */
export async function keystorePath(groupId: string, email: string): Promise<string> {
  const digest = await sha256(utf8(`${groupId}:${email.trim().toLowerCase()}`))
  return `${groupId}/users/${toHex(digest)}.json`
}

export function messagePath(groupId: string, messageId: string): string {
  return `${groupId}/messages/${messageId}.enc`
}

export function filePath(groupId: string, fileId: string): string {
  return `${groupId}/files/${fileId}.enc`
}

export function eventPath(groupId: string, eventId: string): string {
  return `${groupId}/events/${eventId}.enc`
}

export function inboxPath(groupId: string, userId: string, itemId: string): string {
  return `${groupId}/inbox/${userId}/${itemId}.enc`
}
