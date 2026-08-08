<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NotifyView from '../ui/NotifyView.vue'
import { openGroupDatabase } from '../db/group-db'
import { pendingResponders } from '../content/form-results'
import { useSessionStore } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

/** ?pending=1 で来たときだけ、まだ答えていない人に絞る (原稿 07)。 */
const onlyUserIds = ref<string[] | undefined>(undefined)
const loaded = ref(false)

onMounted(async () => {
  const current = session.session
  if (route.query.pending !== '1' || !current) {
    loaded.value = true
    return
  }
  const db = openGroupDatabase(current.groupId)
  const message = await db.messages.get(String(route.params.messageId))
  if (message?.form) {
    const responses = await db.formResponses.where('formId').equals(message.form.id).toArray()
    onlyUserIds.value = pendingResponders({
      roster: current.roster,
      scopes: message.scopes,
      responses,
      excludeUserId: current.userId,
    }).map((person) => person.userId)
  }
  loaded.value = true
})
</script>

<template>
  <NotifyView
    v-if="loaded && session.session && (session.writer ?? session.storage)"
    :session="session.session"
    :storage="(session.writer ?? session.storage)!"
    :message-id="String(route.params.messageId)"
    :only-user-ids="onlyUserIds"
    @close="router.push({ name: 'timeline', params: { groupId: session.groupId } })"
  />
</template>
