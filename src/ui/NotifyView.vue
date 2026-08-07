<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import { openGroupDatabase } from '../db/group-db'
import { readContacts } from '../group/contacts'
import { readGroupSettings } from '../group/group-settings'
import { loadRosterFile } from '../group/roster-update'
import type { Session } from '../group/session'
import { buildMailBatches } from '../notify/mailto'
import type { MailBatch } from '../notify/mailto'
import { markBatchSent, recordBatches } from '../notify/delivery-log'
import { resolveAudience } from '../notify/recipients'
import type { StorageProvider } from '../storage/provider'

const props = defineProps<{
  session: Session
  storage: StorageProvider
  messageId: string
}>()
const emit = defineEmits<{ close: [] }>()

const batches = ref<MailBatch[]>([])
const missingEmail = ref<string[]>([])
const sent = ref<Record<number, boolean>>({})
const error = ref('')
const loaded = ref(false)

const db = openGroupDatabase(props.session.groupId)

onMounted(async () => {
  try {
    const staffKey = props.session.groupKeys.get(keyId(STAFF_SCOPE, 1))
    if (!staffKey) throw new Error('staff スコープ鍵がありません')

    const [file, settings, message] = await Promise.all([
      loadRosterFile({ storage: props.storage, groupId: props.session.groupId }),
      readGroupSettings({
        storage: props.storage,
        groupId: props.session.groupId,
        staffKey,
      }),
      db.messages.get(props.messageId),
    ])
    const contacts = await readContacts({ file, staffKey })

    const audience = resolveAudience({
      roster: props.session.roster,
      contacts,
      settings: settings.notifications,
      scopes: message?.scopes ?? [],
      excludeUserId: props.session.userId,
    })
    missingEmail.value = audience.missingEmail

    batches.value = buildMailBatches({
      recipients: audience.reachable,
      template: settings.mailTemplate,
      groupName: props.session.groupName,
      kind: 'お知らせ',
      link: `${location.origin}/app/`,
      to: '',
    })
    await recordBatches({ db, messageId: props.messageId, batches: batches.value })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '通知を組み立てられませんでした'
  } finally {
    loaded.value = true
  }
})

async function markSent(batch: MailBatch): Promise<void> {
  sent.value = { ...sent.value, [batch.index]: true }
  await markBatchSent({ db, messageId: props.messageId, batchIndex: batch.index })
}
</script>

<template>
  <section v-if="loaded" data-test="ready">
    <h1>メールで知らせる</h1>
    <button type="button" data-test="close" @click="emit('close')">閉じる</button>

    <p>
      リンクを押すとメールアプリが開きます。送信そのものはアプリからは
      <strong>自動では確認できません</strong>ので、送り終えたら「送った」を押してください。
    </p>
    <p>宛先は BCC に入っています。参加者どうしにアドレスは見えません。</p>

    <p v-if="error" data-test="error">{{ error }}</p>

    <p v-if="missingEmail.length > 0" data-test="missing-email">
      メール未登録 {{ missingEmail.length }} 名。この方々には届きません。
    </p>

    <p v-if="batches.length === 0" data-test="nobody">
      メールで知らせられる相手がいません。
    </p>

    <ul v-else>
      <li v-for="batch in batches" :key="batch.index">
        <a data-test="batch-link" :href="batch.url">
          メールを開く ({{ batch.index }}/{{ batch.total }}) · {{ batch.recipients.length }} 名
        </a>
        <button
          type="button"
          data-test="mark-sent"
          :disabled="sent[batch.index] === true"
          @click="markSent(batch)"
        >
          送った
        </button>
      </li>
    </ul>
  </section>
</template>
