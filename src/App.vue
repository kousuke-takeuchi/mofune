<script setup lang="ts">
import { ref } from 'vue'
import LoginView from './ui/LoginView.vue'
import TimelineView from './ui/TimelineView.vue'
import MessageDetailView from './ui/MessageDetailView.vue'
import ComposeView from './ui/ComposeView.vue'
import AbsenceView from './ui/AbsenceView.vue'
import SetupView from './ui/SetupView.vue'
import StaffPanelView from './ui/StaffPanelView.vue'
import AbsenceListView from './ui/AbsenceListView.vue'
import type { Session } from './group/session'
import { isEmailConfirmed } from './group/email-registration'
import { openGroupDatabase } from './db/group-db'
import type { Bytes } from './crypto/bytes'
import { fromBase64 } from './crypto/bytes'
import type { StorageProvider } from './storage/provider'
import { HttpStorageProvider } from './storage/http'

const session = ref<Session | null>(null)
const storage = ref<StorageProvider | null>(null)
const openMessageId = ref<string | null>(null)
const composing = ref(false)
const reporting = ref(false)
const panelOpen = ref(false)
const absenceListOpen = ref(false)
const emailConfirmed = ref(true)
const adminPublicKey = ref<Bytes>(new Uint8Array(0))

async function onLogin(next: Session, root: string, adminKey: string): Promise<void> {
  session.value = next
  storage.value = new HttpStorageProvider(root)
  adminPublicKey.value = fromBase64(adminKey)
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
    <AbsenceListView
      v-else-if="absenceListOpen"
      :session="session"
      @close="absenceListOpen = false"
    />
    <StaffPanelView
      v-else-if="panelOpen"
      :session="session"
      :storage="storage"
      :admin-public-key="adminPublicKey"
      @close="panelOpen = false"
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
      <button v-if="session.role !== 'member'" data-test="staff-panel" @click="panelOpen = true">
        受信と配布
      </button>
      <button
        v-if="session.role !== 'member'"
        data-test="absence-list"
        @click="absenceListOpen = true"
      >
        届いた連絡
      </button>
      <!-- 不在連絡は全ロールが行える(要件書 §3) -->
      <button data-test="report" @click="reporting = true">れんらく</button>
      <TimelineView :session="session" :storage="storage" @open="openMessageId = $event" />
    </template>
  </main>
</template>
