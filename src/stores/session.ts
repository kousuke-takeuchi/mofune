import { defineStore } from 'pinia'
import type { Bytes } from '../crypto/bytes'
import { fromBase64 } from '../crypto/bytes'
import { openGroupDatabase } from '../db/group-db'
import { getGroup, rememberGroup } from '../db/groups'
import type { ConnectionCode } from '../group/connection-code'
import { isEmailConfirmed } from '../group/email-registration'
import type { Role } from '../crypto/roster'
import type { Session } from '../group/session'
import { login } from '../group/session'
import { readProviderFor, writerFor } from '../storage/factory'
import type { StorageProvider } from '../storage/provider'
import { useGroupsStore } from './groups'

export class UnknownGroupError extends Error {}

interface SessionState {
  session: Session | null
  storage: StorageProvider | null
  /**
   * 書き込みができるプロバイダ。担当者と管理者だけが持つ。
   *
   * storage は公開読み専用なので、投稿・回収・投函枠の配布はこちらを使う。
   * 取り違えると「オフラインのため送信待ち」と言い続ける投稿ができあがる。
   */
  writer: StorageProvider | null
  adminPublicKey: Bytes
  emailConfirmed: boolean
}

/**
 * いま解錠されているセッション1つ。リロードで消える。
 *
 * 鍵とパスワードは永続化しない(要件書 §5)。端末に残すのは接続コードと
 * メールアドレスだけで、再開時はパスワードだけを訊く。
 */


export const useSessionStore = defineStore('session', {
  state: (): SessionState => ({
    session: null,
    storage: null,
    writer: null,
    adminPublicKey: new Uint8Array(0),
    emailConfirmed: true,
  }),
  getters: {
    isSignedIn: (state): boolean => state.session !== null && state.storage !== null,
    groupId: (state): string | null => state.session?.groupId ?? null,
    role: (state): Role | null => state.session?.role ?? null,
  },
  actions: {
    /** すでに解錠済みのセッションを受け取る。LoginView が自分でログインするため。 */
    async adopt(session: Session, code: ConnectionCode): Promise<void> {
      this.session = session
      this.storage = readProviderFor(code)
      this.adminPublicKey = fromBase64(code.adminPublicKey)
      // メールアドレス未登録の参加者は、登録が済むまで主要機能をロックする(要件書 §4.6)
      this.emailConfirmed =
        session.role !== 'member' || (await isEmailConfirmed(openGroupDatabase(session.groupId)))
      this.writer = await writerFor({ code, session, storage: this.storage })
      await useGroupsStore().load()
    },

    async signIn(code: ConnectionCode, email: string, password: string): Promise<void> {
      const session = await login({ code, email, password, storage: readProviderFor(code) })
      await rememberGroup({ code, groupName: session.groupName, email, at: Date.now() })
      await this.adopt(session, code)
    },

    async unlock(groupId: string, password: string): Promise<void> {
      const stored = await getGroup(groupId)
      if (!stored) {
        throw new UnknownGroupError('この端末にはこのグループの記録がありません')
      }
      await this.signIn(stored.code, stored.email, password)
    },

    signOut(): void {
      this.session = null
      this.storage = null
      this.writer = null
      this.adminPublicKey = new Uint8Array(0)
      this.emailConfirmed = true
    },
  },
})
