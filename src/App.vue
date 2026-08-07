<script setup lang="ts">
import { ref } from 'vue'
import LoginView from './ui/LoginView.vue'
import TimelineView from './ui/TimelineView.vue'
import MessageDetailView from './ui/MessageDetailView.vue'
import ComposeView from './ui/ComposeView.vue'
import AbsenceView from './ui/AbsenceView.vue'
import SetupView from './ui/SetupView.vue'
import type { Session } from './group/session'
import { isEmailConfirmed } from './group/email-registration'
import { openGroupDatabase } from './db/group-db'
import type { StorageProvider } from './storage/provider'
import { HttpStorageProvider } from './storage/http'

const session = ref<Session | null>(null)
const storage = ref<StorageProvider | null>(null)
const openMessageId = ref<string | null>(null)
const composing = ref(false)
const reporting = ref(false)
const emailConfirmed = ref(true)

async function onLogin(next: Session, root: string): Promise<void> {
  session.value = next
  storage.value = new HttpStorageProvider(root)
  // メールアドレス未登録の参加者は、登録が済むまで主要機能をロックする(要件書 §4.6)
  emailConfirmed.value =
    next.role !== 'member' || (await isEmailConfirmed(openGroupDatabase(next.groupId)))
}
</script>

<template>
  <main>
    <LoginView v-if="!session || !storage" @login="onLogin" />
    <SetupView
      v-else-if="!emailConfirmed"
      :session="session"
      :storage="storage"
      @done="emailConfirmed = true"
    />
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
