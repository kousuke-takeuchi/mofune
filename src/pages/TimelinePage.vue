<script setup lang="ts">
import { useRouter } from 'vue-router'
import BottomNav from '../ui/BottomNav.vue'
import type { NavPlace } from '../ui/BottomNav.vue'
import TimelineView from '../ui/TimelineView.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

function open(messageId: string): void {
  router.push({ name: 'message', params: { groupId: session.groupId, messageId } })
}

function go(place: NavPlace): void {
  const groupId = session.groupId
  if (place === 'absence') router.push({ name: 'absence', params: { groupId } })
  if (place === 'menu') router.push({ name: 'settings', params: { groupId } })
}
</script>

<template>
  <template v-if="session.session && session.storage">
    <button
      v-if="session.role !== 'member'"
      type="button"
      data-test="compose"
      @click="router.push({ name: 'compose', params: { groupId: session.groupId } })"
    >
      お知らせを作る
    </button>
    <button
      v-if="session.role !== 'member'"
      type="button"
      data-test="staff-panel"
      @click="router.push({ name: 'panel', params: { groupId: session.groupId } })"
    >
      受信と配布
    </button>
    <button
      v-if="session.role !== 'member'"
      type="button"
      data-test="absence-list"
      @click="router.push({ name: 'absences', params: { groupId: session.groupId } })"
    >
      届いた連絡
    </button>
    <!-- 不在連絡は全ロールが行える(要件書 §3) -->
    <button
      type="button"
      data-test="report"
      @click="router.push({ name: 'absence', params: { groupId: session.groupId } })"
    >
      れんらく
    </button>
    <TimelineView :session="session.session" :storage="session.storage" @open="open" />
    <BottomNav active="home" @go="go" />
  </template>
</template>
