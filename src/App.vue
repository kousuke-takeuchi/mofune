<script setup lang="ts">
import { ref } from 'vue'
import LoginView from './ui/LoginView.vue'
import TimelineView from './ui/TimelineView.vue'
import type { Session } from './group/session'
import type { StorageProvider } from './storage/provider'
import { HttpStorageProvider } from './storage/http'

const session = ref<Session | null>(null)
const storage = ref<StorageProvider | null>(null)

function onLogin(next: Session, root: string): void {
  session.value = next
  storage.value = new HttpStorageProvider(root)
}
</script>

<template>
  <main>
    <LoginView v-if="!session || !storage" @login="onLogin" />
    <TimelineView v-else :session="session" :storage="storage" />
  </main>
</template>
