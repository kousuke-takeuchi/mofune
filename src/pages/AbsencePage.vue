<script setup lang="ts">
import { useRouter } from 'vue-router'
import AbsenceView from '../ui/AbsenceView.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

function back(): void {
  router.push({ name: 'timeline', params: { groupId: session.groupId } })
}
</script>

<template>
  <AbsenceView
    v-if="session.session && session.storage"
    :session="session.session"
    :storage="session.storage"
    @sent="back"
    @cancel="back"
  />
</template>
