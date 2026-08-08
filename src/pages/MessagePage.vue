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
    v-if="session.session && session.storage"
    :session="session.session"
    :storage="(session.writer ?? session.storage)!"
    :message-id="String(route.params.messageId)"
    @back="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
    @results="
      (formId: string) =>
        router.push({
          name: 'results',
          params: { groupId: session.groupId, messageId: route.params.messageId },
          query: { form: formId },
        })
    "
  />
</template>
