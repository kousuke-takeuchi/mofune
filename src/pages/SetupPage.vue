<script setup lang="ts">
import { useRouter } from 'vue-router'
import SetupView from '../ui/SetupView.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

async function done(): Promise<void> {
  session.emailConfirmed = true
  await router.push({ name: 'timeline', params: { groupId: session.groupId } })
}
</script>

<template>
  <SetupView
    v-if="session.session && session.storage"
    :session="session.session"
    :storage="session.storage"
    @done="done"
  />
</template>
