<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import GroupSwitchView from '../ui/GroupSwitchView.vue'
import { overviewFor } from '../db/overview'
import type { GroupOverview } from '../db/overview'
import { useGroupsStore } from '../stores/groups'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()
const groups = useGroupsStore()

const overview = ref<Record<string, GroupOverview>>({})

onMounted(async () => {
  await groups.load()
  overview.value = await overviewFor(groups.groups.map((group) => group.groupId))
})

/**
 * 開いているグループならそのまま入る。別のグループはセッションが無いので、
 * ガードに任せず解錠画面へ送る。
 */
async function open(groupId: string): Promise<void> {
  if (session.isSignedIn && session.groupId === groupId) {
    await router.push({ name: 'timeline', params: { groupId } })
    return
  }
  await router.push({ name: 'unlock', query: { next: `/g/${groupId}` } })
}
</script>

<template>
  <GroupSwitchView
    :groups="groups.groups"
    :current-group-id="session.groupId"
    :overview="overview"
    @open="open"
    @add="router.push({ name: 'login' })"
  />
</template>
