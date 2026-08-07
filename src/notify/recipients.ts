import type { RosterContents } from '../crypto/roster'
import type { ContactBook } from '../group/contacts'
import type { NotificationSettings } from '../group/group-settings'

export interface Recipient {
  userId: string
  displayName: string
  email: string
}

export interface Audience {
  reachable: Recipient[]
  /** メールアドレスが未登録の userId。黙って落とさず担当者に見せる。 */
  missingEmail: string[]
  /** 通知が止まっていたため配信対象から外したスコープ。 */
  muted: string[]
}

/**
 * 「スコープのメンバー ∩ サブグループ通知が有効 ∩ 個人設定が有効」を解決する
 * (設計書 §9.2)。純関数にしておき、画面からもテストからも同じ結果を得る。
 */
export function resolveAudience(options: {
  roster: RosterContents
  contacts: ContactBook
  settings: NotificationSettings
  scopes: string[]
  excludeUserId?: string
}): Audience {
  const muted = options.scopes.filter((scope) =>
    options.settings.mutedScopes.includes(scope),
  )
  const active = options.scopes.filter((scope) => !muted.includes(scope))

  const reachable: Recipient[] = []
  const missingEmail: string[] = []

  for (const member of options.roster.members) {
    if (member.userId === options.excludeUserId) continue
    if (!member.scopes.some((scope) => active.includes(scope))) continue

    const email = options.contacts[member.userId]?.email?.trim() ?? ''
    if (email.length === 0) {
      missingEmail.push(member.userId)
      continue
    }
    reachable.push({
      userId: member.userId,
      displayName: member.displayName,
      email,
    })
  }

  return { reachable, missingEmail, muted }
}
