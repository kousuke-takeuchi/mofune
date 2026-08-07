<script setup lang="ts">
import { useRouter } from 'vue-router'
import ComposeView from '../ui/ComposeView.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

function posted(messageId: string): void {
  router.push({ name: 'notify', params: { groupId: session.groupId, messageId } })
}
</script>

<template>
  <!-- 投稿は書き込みプロバイダで行う。公開読みのプロバイダでは必ず失敗する。 -->
  <ComposeView
    v-if="session.session && (session.writer ?? session.storage)"
    :session="session.session"
    :storage="(session.writer ?? session.storage)!"
    @posted="posted"
    @cancel="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
