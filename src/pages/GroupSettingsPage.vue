<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import GroupSettingsView from '../ui/GroupSettingsView.vue'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import type { GroupSettings } from '../group/group-settings'
import { readGroupSettings, writeGroupSettings } from '../group/group-settings'
import { decodeManifest, setFunctionUrl } from '../group/manifest'
import { manifestPath } from '../storage/paths'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

const settings = ref<GroupSettings | null>(null)
const functionUrl = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')

/** 設定は staff スコープ鍵で封緘されている。担当者と管理者しか読めない。 */
function staffKey(): CryptoKey | undefined {
  const current = session.session
  return current?.groupKeys.get(keyId(STAFF_SCOPE, current.generation))
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
    functionUrl.value =
      decodeManifest(await session.storage.get(manifestPath(session.groupId))).functionUrl ?? ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '設定を読めませんでした'
  }
})

async function save(next: GroupSettings, nextFunctionUrl: string): Promise<void> {
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
      generation: session.session?.generation ?? 1,
    })
    // manifest は平文。参加者もログイン前に読むので、URL だけはこちらへ書く
    if (nextFunctionUrl !== functionUrl.value) {
      await setFunctionUrl({
        storage: session.writer,
        groupId: session.groupId,
        functionUrl: nextFunctionUrl,
      })
      functionUrl.value = nextFunctionUrl
    }
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
    :function-url="functionUrl"
    @save="save"
    @close="router.push({ name: 'settings', params: { groupId: session.groupId } })"
  />
</template>
