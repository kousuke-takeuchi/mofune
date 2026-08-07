<script setup lang="ts">
import { ref } from 'vue'
import LoginView from './ui/LoginView.vue'
import TimelineView from './ui/TimelineView.vue'
import MessageDetailView from './ui/MessageDetailView.vue'
import ComposeView from './ui/ComposeView.vue'
import AbsenceView from './ui/AbsenceView.vue'
import type { Session } from './group/session'
import type { StorageProvider } from './storage/provider'
import { HttpStorageProvider } from './storage/http'

const session = ref<Session | null>(null)
const storage = ref<StorageProvider | null>(null)
const openMessageId = ref<string | null>(null)
const composing = ref(false)
const reporting = ref(false)

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
    <AbsenceView
      v-else-if="reporting"
      :session="session"
      :storage="storage"
      @sent="reporting = false"
      @cancel="reporting = false"
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
      <!-- 不在連絡は全ロールが行える(要件書 §3) -->
      <button data-test="report" @click="reporting = true">れんらく</button>
      <TimelineView :session="session" :storage="storage" @open="openMessageId = $event" />
    </template>
  </main>
</template>
