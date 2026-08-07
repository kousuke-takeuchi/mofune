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
  <ComposeView
    v-if="session.session && session.storage"
    :session="session.session"
    :storage="session.storage"
    @posted="posted"
    @cancel="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
