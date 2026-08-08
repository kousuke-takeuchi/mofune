<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import FormResultsView from '../ui/FormResultsView.vue'
import type { FormDefinition } from '../content/forms'
import { collectFormResponses } from '../content/form-exchange'
import { pendingResponders } from '../content/form-results'
import type { Responder } from '../content/form-results'
import type { StoredFormResponse } from '../db/group-db'
import { openGroupDatabase } from '../db/group-db'
import { useSessionStore } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const form = ref<FormDefinition | null>(null)
const responses = ref<StoredFormResponse[]>([])
const pending = ref<Responder[]>([])
const loaded = ref(false)
const audience = ref(0)
const busy = ref(false)
const error = ref('')

const db = openGroupDatabase(String(route.params.groupId))

async function load(): Promise<void> {
  const message = await db.messages.get(String(route.params.messageId))
  form.value = message?.form ?? null
  if (form.value) {
    responses.value = await db.formResponses.where('formId').equals(form.value.id).toArray()
  }
  const current = session.session
  if (current && message) {
    // 宛先はお知らせのスコープ。名簿全員ではない
    pending.value = pendingResponders({
      roster: current.roster,
      scopes: message.scopes,
      responses: responses.value,
      excludeUserId: current.userId,
    })
    audience.value = pending.value.length + responses.value.length
  }
}

onMounted(async () => {
  await load()
  loaded.value = true
})

async function collect(): Promise<void> {
  if (!session.session || !session.storage) return
  error.value = ''
  busy.value = true
  try {
    await collectFormResponses({
      session: session.session,
      // 回収は受信箱の削除を伴うので、書ける経路で行う
      storage: session.writer ?? session.storage,
      db,
    })
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '受け取れませんでした'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <!-- 白い画面を出さない。見つからない理由を書く -->
  <p v-if="loaded && !form" data-test="not-found">
    このお知らせには回答フォームがありません。同期がまだの可能性もあります。
  </p>

  <FormResultsView
    v-if="form && session.session"
    :form="form"
    :responses="responses"
    :audience="audience"
    :pending="pending"
    :busy="busy"
    :error="error"
    @collect="collect"
    @remind="
      router.push({
        name: 'notify',
        params: { groupId: session.groupId, messageId: route.params.messageId },
        query: { pending: '1' },
      })
    "
    @close="
      router.push({
        name: 'message',
        params: { groupId: session.groupId, messageId: route.params.messageId },
      })
    "
  />
</template>
