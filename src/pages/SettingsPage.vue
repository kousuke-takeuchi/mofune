<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import BottomNav from '../ui/BottomNav.vue'
import type { NavPlace } from '../ui/BottomNav.vue'
import SettingsView from '../ui/SettingsView.vue'
import { openGroupDatabase } from '../db/group-db'
import { getGroup } from '../db/groups'
import { readLastSyncedAt } from '../sync/sync'
import { useGroupsStore } from '../stores/groups'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()
const groups = useGroupsStore()

const loginId = ref('')
const lastSyncedAt = ref<string | null>(null)

onMounted(async () => {
  const groupId = session.groupId
  if (!groupId) return
  lastSyncedAt.value = await readLastSyncedAt(openGroupDatabase(groupId))
  loginId.value = (await getGroup(groupId))?.loginId ?? ''
})

/** ログアウトしても端末の記録は残す。次はパスワードだけで戻れる。 */
async function signOut(): Promise<void> {
  const groupId = session.groupId
  session.signOut()
  await router.push({ name: 'unlock', query: groupId ? { next: `/g/${groupId}` } : {} })
}

async function forgetDevice(): Promise<void> {
  const groupId = session.groupId
  if (groupId) await groups.forget(groupId)
  session.signOut()
  await router.push({ name: 'login' })
}

function go(place: NavPlace): void {
  const groupId = session.groupId
  if (place === 'home') router.push({ name: 'timeline', params: { groupId } })
  if (place === 'absence') router.push({ name: 'absence', params: { groupId } })
}
</script>

<template>
  <div v-if="session.session" class="stack">
    <SettingsView
      :session="session.session"
      :login-id="loginId"
      :last-synced-at="lastSyncedAt"
      @sign-out="signOut"
      @forget-device="forgetDevice"
      @register-email="router.push({ name: 'setup', params: { groupId: session.groupId } })"
    />
    <button
      type="button"
      class="wide"
      data-test="switch-group"
      @click="router.push({ name: 'groups' })"
    >
      グループを切り替える
    </button>
    <BottomNav active="menu" @go="go" />
  </div>
</template>
