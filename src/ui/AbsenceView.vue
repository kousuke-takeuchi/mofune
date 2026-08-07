<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AbsenceKind } from '../content/absence'
import { ABSENCE_KINDS, DEFAULT_REASONS, buildAbsenceReport, sendAbsenceReport } from '../content/absence'
import { openGroupDatabase } from '../db/group-db'
import type { Session } from '../group/session'
import type { InboxGrant } from '../inbox/grants'
import { readGrant } from '../inbox/grants'
import type { StorageProvider } from '../storage/provider'
import { flushOutbox } from '../sync/outbox'

const props = defineProps<{ session: Session; storage: StorageProvider }>()
const emit = defineEmits<{ sent: []; cancel: [] }>()

const KIND_LABELS: Record<AbsenceKind, string> = {
  absent: '欠席',
  late: '遅れます',
  early: '早く帰ります',
}

const grant = ref<InboxGrant | null>(null)
const loaded = ref(false)
const kind = ref<AbsenceKind>('absent')
const date = ref(new Date().toISOString().slice(0, 10))
const reason = ref('')
const note = ref('')
const error = ref('')
const queued = ref(false)
const busy = ref(false)

const db = openGroupDatabase(props.session.groupId)

onMounted(async () => {
  try {
    grant.value = await readGrant({
      storage: props.storage,
      groupId: props.session.groupId,
      userId: props.session.userId,
      ecdhPrivate: props.session.ecdhPrivate,
    })
  } catch {
    grant.value = null
  } finally {
    loaded.value = true
  }
})

/** 枠が無くても、書き込み資格情報があれば自分で投函できる (担当者・管理者)。 */
const canSubmit = computed(() => grant.value !== null || props.storage.capabilities.write)

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  error.value = ''
  queued.value = false
  busy.value = true
  try {
    const report = buildAbsenceReport({
      session: props.session,
      kind: kind.value,
      date: date.value,
      reason: reason.value,
      note: note.value,
    })
    await sendAbsenceReport({ session: props.session, db, grant: grant.value, report })
    const flushed = await flushOutbox({ db, storage: props.storage })
    if (flushed.failed > 0) {
      queued.value = true
    } else {
      emit('sent')
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '送信できませんでした'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="loaded">
    <h1>欠席・不在をつたえる</h1>

    <p v-if="!canSubmit" data-test="no-slots">
      いまは送信できません。担当者がアプリを開くと送信枠が用意されます。
    </p>

    <div v-else data-test="ready">
      <fieldset>
        <legend>どの日ですか</legend>
        <input type="date" data-test="date" v-model="date" />
      </fieldset>

      <fieldset>
        <legend>種類</legend>
        <button
          v-for="value in ABSENCE_KINDS"
          :key="value"
          type="button"
          data-test="kind"
          :data-kind="value"
          :aria-pressed="kind === value"
          @click="kind = value"
        >
          {{ KIND_LABELS[value] }}
        </button>
      </fieldset>

      <fieldset>
        <legend>理由(よく使うものから)</legend>
        <button
          v-for="value in DEFAULT_REASONS"
          :key="value"
          type="button"
          data-test="reason"
          :aria-pressed="reason === value"
          @click="reason = value"
        >
          {{ value }}
        </button>
      </fieldset>

      <label>
        ひとこと
        <textarea data-test="note" v-model="note"></textarea>
      </label>

      <p>この内容は宛先の担当者だけが読めます</p>

      <p v-if="error" data-test="error">{{ error }}</p>
      <p v-if="queued" data-test="queued">
        オフラインのため送信待ちにしました。オンラインに戻ると自動で送信されます。
      </p>

      <button type="button" class="quiet" data-test="cancel" @click="emit('cancel')">キャンセル</button>
      <button type="button" class="primary" data-test="submit" :disabled="busy" @click="submit">送信する</button>
    </div>
  </section>
</template>
