<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import MessageDetailView from '../ui/MessageDetailView.vue'
import { useSessionStore } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
</script>

<template>
  <MessageDetailView
    v-if="session.session"
    :session="session.session"
    :message-id="String(route.params.messageId)"
    @back="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
