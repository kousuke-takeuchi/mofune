<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import NotifyView from '../ui/NotifyView.vue'
import { useSessionStore } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
</script>

<template>
  <NotifyView
    v-if="session.session && session.storage"
    :session="session.session"
    :storage="session.storage"
    :message-id="String(route.params.messageId)"
    @close="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
