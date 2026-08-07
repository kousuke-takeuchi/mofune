<script setup lang="ts">
import { useRouter } from 'vue-router'
import AbsenceListView from '../ui/AbsenceListView.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()
</script>

<template>
  <AbsenceListView
    v-if="session.session"
    :session="session.session"
    @close="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
