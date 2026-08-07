<script setup lang="ts">
import { useRouter } from 'vue-router'
import StaffPanelView from '../ui/StaffPanelView.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()
</script>

<template>
  <StaffPanelView
    v-if="session.session && session.storage"
    :session="session.session"
    :storage="session.storage"
    :admin-public-key="session.adminPublicKey"
    @close="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
