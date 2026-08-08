<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import GroupSettingsView from '../ui/GroupSettingsView.vue'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import type { GroupSettings } from '../group/group-settings'
import { readGroupSettings, writeGroupSettings } from '../group/group-settings'
import { INITIAL_GENERATION } from '../group/provision'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

const settings = ref<GroupSettings | null>(null)
const busy = ref(false)
const error = ref('')
const notice = ref('')

/** 設定は staff スコープ鍵で封緘されている。担当者と管理者しか読めない。 */
function staffKey(): CryptoKey | undefined {
  return session.session?.groupKeys.get(keyId(STAFF_SCOPE, INITIAL_GENERATION))
}

onMounted(async () => {
  const key = staffKey()
  if (!session.storage || !session.groupId || !key) return
  try {
    settings.value = await readGroupSettings({
      storage: session.storage,
      groupId: session.groupId,
      staffKey: key,
    })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '設定を読めませんでした'
  }
})

async function save(next: GroupSettings): Promise<void> {
  const key = staffKey()
  if (!session.writer || !session.groupId || !key) return
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    await writeGroupSettings({
      storage: session.writer,
      groupId: session.groupId,
      settings: next,
      staffKey: key,
      generation: INITIAL_GENERATION,
    })
    settings.value = next
    notice.value = '保存しました。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存できませんでした'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <GroupSettingsView
    v-if="settings && session.session"
    :settings="settings"
    :subgroups="session.session.roster.subgroups"
    :busy="busy"
    :error="error"
    :notice="notice"
    @save="save"
    @close="router.push({ name: 'settings', params: { groupId: session.groupId } })"
  />
</template>
