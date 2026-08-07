<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import LoginView from '../ui/LoginView.vue'
import { safeNext } from '../router'
import type { Session } from '../group/session'
import { useSessionStore } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

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
  <div>
    <LoginView @login="onLogin" />
    <button type="button" data-test="provision" @click="router.push({ name: 'provision' })">
      グループを作る
    </button>
  </div>
</template>
