<script setup lang="ts">
import { computed, ref } from 'vue'
import { createPost } from '../content/post'
import type { DraftAttachment } from '../content/post'
import { openGroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import { ALL_SCOPE } from '../crypto/roster'
import type { StorageProvider } from '../storage/provider'
import { flushOutbox } from '../sync/outbox'

const props = defineProps<{ session: Session; storage: StorageProvider }>()
const emit = defineEmits<{ posted: [messageId: string]; cancel: [] }>()

const body = ref('')
const selected = ref<Record<string, boolean>>({})
const attachments = ref<DraftAttachment[]>([])
const error = ref('')
const queued = ref(false)
const busy = ref(false)

const db = openGroupDatabase(props.session.groupId)

const canPost = computed(() => props.session.role !== 'member')

/** 鍵を持っているスコープだけを選択肢にする。staff スコープは配信先ではない。 */
const options = computed(() => {
  const held = new Set(
    [...props.session.groupKeys.keys()].map((id) => id.slice(0, id.lastIndexOf(':v'))),
  )
  const list: { id: string; label: string }[] = []
  if (held.has(ALL_SCOPE)) list.push({ id: ALL_SCOPE, label: 'グループ全体' })
  for (const subgroup of props.session.roster.subgroups) {
    if (held.has(subgroup.id)) list.push({ id: subgroup.id, label: subgroup.name })
  }
  return list
})

async function submit(): Promise<void> {
  error.value = ''
  queued.value = false
  busy.value = true
  try {
    const scopes = Object.entries(selected.value)
      .filter(([, on]) => on)
      .map(([id]) => id)
    const result = await createPost({
      session: props.session,
      db,
      draft: { body: body.value, scopes, attachments: attachments.value },
    })
    // flushOutbox は失敗しても例外を投げず、失敗件数を返す
    const flushed = await flushOutbox({ db, storage: props.storage })
    if (flushed.failed > 0) {
      queued.value = true
    } else {
      emit('posted', result.messageId)
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '送信できませんでした'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section>
    <p v-if="!canPost" data-test="not-allowed">投稿できるのは担当者と管理者だけです。</p>

    <form v-else @submit.prevent="submit">
      <fieldset>
        <legend>届ける相手</legend>
        <label v-for="option in options" :key="option.id">
          <input
            type="checkbox"
            data-test="scope-option"
            :data-scope="option.id"
            :value="option.id"
            v-model="selected[option.id]"
          />
          {{ option.label }}
        </label>
      </fieldset>

      <textarea data-test="body" v-model="body"></textarea>

      <p v-if="error" data-test="error">{{ error }}</p>
      <p v-if="queued" data-test="queued">
        オフラインのため送信待ちにしました。オンラインに戻ると自動で送信されます。
      </p>

      <button type="button" class="quiet" data-test="cancel" @click="emit('cancel')">キャンセル</button>
      <button type="button" class="primary" data-test="submit" :disabled="busy" @click="submit">送信する</button>
    </form>
  </section>
</template>
