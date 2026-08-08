<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { CachedMessage } from '../db/group-db'
import { openGroupDatabase } from '../db/group-db'
import AppBar from './AppBar.vue'
import { formatWhen } from './format'
import { isClosed } from '../content/forms'
import { sendFormResponse } from '../content/form-exchange'
import { flushOutbox } from '../sync/outbox'
import type { StorageProvider } from '../storage/provider'
import type { Session } from '../group/session'

interface ResolvedAttachment {
  id: string
  mediaType: string
  url: string
}

const props = defineProps<{ session: Session; messageId: string; storage: StorageProvider }>()
const emit = defineEmits<{ back: []; results: [formId: string] }>()

const choice = ref('')
const note = ref('')
const answering = ref(false)
const answered = ref(false)
const answerError = ref('')

async function answer(): Promise<void> {
  const form = message.value?.form
  if (!form) return
  answerError.value = ''
  answering.value = true
  try {
    await sendFormResponse({
      session: props.session,
      db,
      storage: props.storage,
      form,
      messageId: props.messageId,
      choice: choice.value,
      note: note.value,
    })
    const flushed = await flushOutbox({ db, storage: props.storage })
    if (flushed.failed > 0) {
      answerError.value = 'いまは送れませんでした。あとでもう一度お試しください。'
    } else {
      answered.value = true
    }
  } catch (cause) {
    answerError.value = cause instanceof Error ? cause.message : '送れませんでした'
  } finally {
    answering.value = false
  }
}

const message = ref<CachedMessage | null>(null)
const attachments = ref<ResolvedAttachment[]>([])
const missingAttachments = ref<string[]>([])
const notFound = ref(false)

const db = openGroupDatabase(props.session.groupId)

function authorName(userId: string): string {
  return (
    props.session.roster.members.find((member) => member.userId === userId)?.displayName ?? '不明'
  )
}

onMounted(async () => {
  try {
    const found = await db.messages.get(props.messageId)
    if (!found) {
      notFound.value = true
      return
    }
    message.value = found

    // 添付を1件ずつ直列に待つと、呼び出し側が待つティック数に依存して
    // 表示が欠ける。既読の記録も含めて1段にまとめる。
    // 既読はローカルにだけ記録する。送出は一切しない(要件書 §4.10)。
    const [files] = await Promise.all([
      Promise.all(found.attachments.map((fileId) => db.files.get(fileId))),
      db.syncState.put({ key: 'lastReadAt', value: new Date().toISOString() }),
    ])

    found.attachments.forEach((fileId, index) => {
      const file = files[index]
      if (!file) {
        missingAttachments.value.push(fileId)
        return
      }
      const blob = new Blob([file.blob], { type: file.mediaType })
      attachments.value.push({
        id: fileId,
        mediaType: file.mediaType,
        url: URL.createObjectURL(blob),
      })
    })
  } catch {
    // 端末の登録解除(設計書 §5.4)などで DB が閉じられた場合。画面は壊さない。
  }
})

onBeforeUnmount(() => {
  for (const attachment of attachments.value) {
    URL.revokeObjectURL(attachment.url)
  }
})
</script>

<template>
  <section>
    <AppBar title="お知らせ">
      <template #left>
        <button type="button" class="quiet" data-test="back" @click="emit('back')">戻る</button>
      </template>
    </AppBar>

    <p v-if="notFound" data-test="not-found">このお知らせは見つかりませんでした。</p>

    <article v-else-if="message">
      <p>{{ authorName(message.author) }}・{{ formatWhen(message.at) }}</p>
      <h2 v-if="message.title" data-test="title">{{ message.title }}</h2>
      <p data-test="body">{{ message.body }}</p>

      <div v-for="attachment in attachments" :key="attachment.id">
        <img
          v-if="attachment.mediaType.startsWith('image/')"
          data-test="attachment-image"
          :src="attachment.url"
          alt=""
        />
        <a v-else data-test="attachment-link" :href="attachment.url" download>添付を開く</a>
      </div>

      <p v-for="fileId in missingAttachments" :key="fileId" data-test="attachment-missing">
        添付はまだ受信できていません。
      </p>

      <section v-if="message.form" data-test="form">
        <h2>{{ message.form.question }}</h2>
        <p v-if="message.form.dueAt" class="hint">
          {{ formatWhen(message.form.dueAt) }} まで
        </p>

        <p v-if="isClosed(message.form)" data-test="form-closed">
          回答の締切を過ぎました。
        </p>
        <p v-else-if="answered" data-test="form-thanks">回答を送りました。ありがとうございます。</p>
        <template v-else>
          <fieldset>
            <legend>回答</legend>
            <button
              v-for="option in message.form.choices"
              :key="option"
              type="button"
              data-test="form-choice"
              :aria-pressed="choice === option"
              @click="choice = option"
            >
              {{ option }}
            </button>
          </fieldset>
          <label v-if="message.form.allowNote">
            ひとこと(任意)
            <textarea data-test="form-note" v-model="note"></textarea>
          </label>
          <p class="hint">この回答は、質問した人だけが読めます。</p>
          <p v-if="answerError" data-test="form-error">{{ answerError }}</p>
          <button
            type="button"
            class="primary"
            data-test="form-submit"
            :disabled="answering || choice === ''"
            @click="answer"
          >
            回答を送る
          </button>
        </template>

        <button
          v-if="message.form.recipient.userId === session.userId"
          type="button"
          data-test="form-results"
          @click="emit('results', message.form.id)"
        >
          回答を集計する
        </button>
      </section>
    </article>
  </section>
</template>
