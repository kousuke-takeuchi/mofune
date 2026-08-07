<script setup lang="ts">
import { ref } from 'vue'
import LoginView from './ui/LoginView.vue'
import TimelineView from './ui/TimelineView.vue'
import MessageDetailView from './ui/MessageDetailView.vue'
import ComposeView from './ui/ComposeView.vue'
import type { Session } from './group/session'
import type { StorageProvider } from './storage/provider'
import { HttpStorageProvider } from './storage/http'

const session = ref<Session | null>(null)
const storage = ref<StorageProvider | null>(null)
const openMessageId = ref<string | null>(null)
const composing = ref(false)

function onLogin(next: Session, root: string): void {
  session.value = next
  storage.value = new HttpStorageProvider(root)
}
</script>

<template>
  <main>
    <LoginView v-if="!session || !storage" @login="onLogin" />
    <ComposeView
      v-else-if="composing"
      :session="session"
      :storage="storage"
      @posted="composing = false"
      @cancel="composing = false"
    />
    <MessageDetailView
      v-else-if="openMessageId"
      :session="session"
      :message-id="openMessageId"
      @back="openMessageId = null"
    />
    <template v-else>
      <button v-if="session.role !== 'member'" data-test="compose" @click="composing = true">
        お知らせを作る
      </button>
      <TimelineView :session="session" :storage="storage" @open="openMessageId = $event" />
    </template>
  </main>
</template>
