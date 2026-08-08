<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Bytes } from '../crypto/bytes'
import { createPost } from '../content/post'
import type { DraftAttachment } from '../content/post'
import { openGroupDatabase } from '../db/group-db'
import AppBar from './AppBar.vue'
import type { Session } from '../group/session'
import { ALL_SCOPE } from '../crypto/roster'
import type { StorageProvider } from '../storage/provider'
import { DEFAULT_ATTENDANCE_CHOICES, buildForm } from '../content/forms'
import { rebuildEventIndex } from '../sync/event-index'
import { flushOutbox } from '../sync/outbox'

const props = defineProps<{ session: Session; storage: StorageProvider }>()
const emit = defineEmits<{ posted: [messageId: string]; cancel: [] }>()

const title = ref('')
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

const withForm = ref(false)
const question = ref('')
const choices = ref<string[]>([...DEFAULT_ATTENDANCE_CHOICES])
const allowNote = ref(true)
const dueAt = ref('')

function addChoice(): void {
  choices.value.push('')
}

function removeChoice(index: number): void {
  choices.value.splice(index, 1)
}

/** 選んだファイルを読み込む。暗号化は createPost が受け持つ。 */
async function pickFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const picked = [...(input.files ?? [])]
  for (const file of picked) {
    attachments.value.push({
      name: file.name,
      mediaType: file.type || 'application/octet-stream',
      bytes: new Uint8Array(await file.arrayBuffer()) as Bytes,
    })
  }
  // 同じファイルをもう一度選べるようにする
  input.value = ''
}

function removeAttachment(index: number): void {
  attachments.value.splice(index, 1)
}

async function submit(): Promise<void> {
  error.value = ''
  queued.value = false
  busy.value = true
  try {
    const scopes = Object.entries(selected.value)
      .filter(([, on]) => on)
      .map(([id]) => id)
    const form = withForm.value
      ? buildForm({
          session: props.session,
          question: question.value,
          choices: choices.value,
          allowNote: allowNote.value,
          dueAt: dueAt.value ? new Date(dueAt.value).toISOString() : null,
        })
      : undefined
    const result = await createPost({
      session: props.session,
      db,
      draft: {
        title: title.value,
        body: body.value,
        scopes,
        attachments: attachments.value,
        ...(form ? { form } : {}),
      },
    })
    // flushOutbox は失敗しても例外を投げず、失敗件数を返す
    const flushed = await flushOutbox({ db, storage: props.storage })
    if (flushed.failed > 0) {
      queued.value = true
    } else {
      // 参加者は一覧を取れないので、索引を更新しないと今の投稿が誰にも届かない
      if (props.storage.capabilities.list && props.storage.capabilities.write) {
        await rebuildEventIndex({ storage: props.storage, groupId: props.session.groupId })
      }
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
    <AppBar title="お知らせを作る">
      <template #left>
        <button type="button" class="quiet" data-test="cancel" @click="emit('cancel')">
          キャンセル
        </button>
      </template>
    </AppBar>

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

      <label>
        見出し
        <input data-test="title" v-model="title" placeholder="来週の集まりについて" />
      </label>

      <label>
        本文
        <textarea data-test="body" v-model="body"></textarea>
      </label>

      <label>
        写真やPDFを添付
        <input
          type="file"
          data-test="attach"
          multiple
          accept="image/*,application/pdf"
          @change="pickFiles"
        />
      </label>

      <ul v-if="attachments.length > 0">
        <li v-for="(attachment, index) in attachments" :key="index" data-test="attachment">
          <div class="row">
            <span class="titles">{{ attachment.name }}</span>
            <button type="button" class="quiet danger" data-test="remove-attachment" @click="removeAttachment(index)">
              外す
            </button>
          </div>
        </li>
      </ul>

      <label>
        <input type="checkbox" data-test="with-form" v-model="withForm" />
        出欠やアンケートを入れる
      </label>

      <template v-if="withForm">
        <label>
          質問
          <input data-test="form-question" v-model="question" />
        </label>
        <fieldset>
          <legend>選択肢</legend>
          <div v-for="(_, index) in choices" :key="index" class="row">
            <input data-test="form-choice" v-model="choices[index]" />
            <button
              type="button"
              class="quiet danger"
              data-test="remove-choice"
              @click="removeChoice(index)"
            >
              外す
            </button>
          </div>
        </fieldset>
        <button type="button" data-test="add-choice" @click="addChoice">選択肢を足す</button>
        <label>
          <input type="checkbox" data-test="allow-note" v-model="allowNote" />
          ひとこと欄を出す
        </label>
        <label>
          回答の締切 (任意)
          <input type="datetime-local" data-test="form-due" v-model="dueAt" />
        </label>
        <p class="hint">回答はあなたの端末だけで開けます。ほかの担当者にも見えません。</p>
      </template>

      <p v-if="error" data-test="error">{{ error }}</p>
      <p v-if="queued" data-test="queued">
        オフラインのため送信待ちにしました。オンラインに戻ると自動で送信されます。
      </p>

      <button type="button" class="primary" data-test="submit" :disabled="busy" @click="submit">送信する</button>
    </form>
  </section>
</template>
