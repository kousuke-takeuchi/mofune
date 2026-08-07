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
import { HttpStorageProvider } from '../storage/http'
import type { StorageProvider } from '../storage/provider'
import { useGroupsStore } from './groups'

export class UnknownGroupError extends Error {}

interface SessionState {
  session: Session | null
  storage: StorageProvider | null
  adminPublicKey: Bytes
  emailConfirmed: boolean
}

/**
 * いま解錠されているセッション1つ。リロードで消える。
 *
 * 鍵とパスワードは永続化しない(要件書 §5)。端末に残すのは接続コードと
 * ログインIDだけで、再開時はパスワードだけを訊く。
 */
export const useSessionStore = defineStore('session', {
  state: (): SessionState => ({
    session: null,
    storage: null,
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
    async adopt(session: Session, root: string, adminPublicKey: string): Promise<void> {
      this.session = session
      this.storage = new HttpStorageProvider(root)
      this.adminPublicKey = fromBase64(adminPublicKey)
      // メールアドレス未登録の参加者は、登録が済むまで主要機能をロックする(要件書 §4.6)
      this.emailConfirmed =
        session.role !== 'member' || (await isEmailConfirmed(openGroupDatabase(session.groupId)))
      await useGroupsStore().load()
    },

    async signIn(code: ConnectionCode, loginId: string, password: string): Promise<void> {
      const storage = new HttpStorageProvider(code.root)
      const session = await login({ code, loginId, password, storage })
      await rememberGroup({ code, groupName: session.groupName, loginId, at: Date.now() })
      await this.adopt(session, code.root, code.adminPublicKey)
    },

    async unlock(groupId: string, password: string): Promise<void> {
      const stored = await getGroup(groupId)
      if (!stored) {
        throw new UnknownGroupError('この端末にはこのグループの記録がありません')
      }
      await this.signIn(stored.code, stored.loginId, password)
    },

    signOut(): void {
      this.session = null
      this.storage = null
      this.adminPublicKey = new Uint8Array(0)
      this.emailConfirmed = true
    },
  },
})
