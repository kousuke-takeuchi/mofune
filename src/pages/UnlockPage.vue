<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UnlockView from '../ui/UnlockView.vue'
import { safeNext } from '../router'
import { useGroupsStore } from '../stores/groups'
import { useSessionStore } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const groups = useGroupsStore()

const groupId = ref('')
const groupName = ref('')
const email = ref('')
const loaded = ref(false)
const busy = ref(false)
const error = ref('')

/** 戻り先の /g/<id>/... から、どのグループを解錠するかを読む。 */
function groupIdFromNext(next: string | null): string | null {
  return next?.match(/^\/g\/([^/]+)/)?.[1] ?? null
}

onMounted(async () => {
  await groups.load()
  const wanted = groupIdFromNext(safeNext(route.query.next)) ?? groups.lastGroupId
  const stored = groups.groups.find((group) => group.groupId === wanted)
  if (!stored) {
    await router.push({ name: 'login' })
    return
  }
  groupId.value = stored.groupId
  groupName.value = stored.groupName
  email.value = stored.email
  // 記録を読み終えるまで出さない。空の状態で押せると、どのグループを
  // 解錠するのか決まらないまま操作できてしまう。
  loaded.value = true
})

async function unlock(password: string): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    await session.unlock(groupId.value, password)
    const next = safeNext(route.query.next)
    await router.push(next ?? `/g/${groupId.value}`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function forget(): Promise<void> {
  await groups.forget(groupId.value)
  await router.push({ name: 'login' })
}
</script>

<template>
  <UnlockView
    v-if="loaded"
    :group-name="groupName"
    :email="email"
    :busy="busy"
    :error="error"
    @unlock="unlock"
    @switch-group="router.push({ name: 'login' })"
    @forget="forget"
  />
</template>
