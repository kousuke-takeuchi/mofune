<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import LoginView from '../ui/LoginView.vue'
import { connectionCodeFromQuery } from '../group/join-url'
import { safeNext } from '../router'
import type { Session } from '../group/session'
import { useSessionStore } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

/** 紙の QR から開くと ?c=<接続コード> が付いてくる。 */
const initialCode = connectionCodeFromQuery(route.query.c)

/**
 * LoginView は自分でログインを済ませてセッションを渡してくる。
 * ストアはその結果を受け取るだけにして、二重にログインしない。
 */
async function onLogin(next: Session, root: string, adminPublicKey: string): Promise<void> {
  await session.adopt(next, root, adminPublicKey)
  const back = safeNext(route.query.next)
  await router.push(back ?? { name: 'timeline', params: { groupId: next.groupId } })
}
</script>

<template>
  <div class="stack">
    <LoginView :initial-code="initialCode" @login="onLogin" />
    <button type="button" class="wide" data-test="provision" @click="router.push({ name: 'provision' })">
      グループを作る
    </button>
    <button type="button" class="quiet" data-test="recover" @click="router.push({ name: 'recover' })">
      管理者の方: 復元コードから入り直す
    </button>
  </div>
</template>
