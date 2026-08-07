<script setup lang="ts">
import { useRouter } from 'vue-router'
import AbsenceView from '../ui/AbsenceView.vue'
import BottomNav from '../ui/BottomNav.vue'
import type { NavPlace } from '../ui/BottomNav.vue'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

function back(): void {
  router.push({ name: 'timeline', params: { groupId: session.groupId } })
}

function go(place: NavPlace): void {
  const groupId = session.groupId
  if (place === 'home') router.push({ name: 'timeline', params: { groupId } })
  if (place === 'menu') router.push({ name: 'settings', params: { groupId } })
}
</script>

<template>
  <div v-if="session.session && session.storage" class="stack">
    <!-- 担当者は書き込み経路で直接投函する。参加者は公開読みのまま枠を使う。 -->
    <AbsenceView
      :session="session.session"
      :storage="(session.writer ?? session.storage)!"
      @sent="back"
      @cancel="back"
    />
    <BottomNav active="absence" @go="go" />
  </div>
</template>
