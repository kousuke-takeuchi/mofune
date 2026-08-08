<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import { openGroupDatabase } from '../db/group-db'
import AppBar from './AppBar.vue'
import { readContacts } from '../group/contacts'
import { readGroupSettings } from '../group/group-settings'
import { loadRosterFile } from '../group/roster-update'
import type { Session } from '../group/session'
import { buildMailBatches } from '../notify/mailto'
import type { MailBatch } from '../notify/mailto'
import { markBatchSent, recordBatches } from '../notify/delivery-log'
import { resolveAudience } from '../notify/recipients'
import { checkFunction, notifyScopes } from '../notify/push'
import { decodeManifest } from '../group/manifest'
import { manifestPath } from '../storage/paths'
import type { StorageProvider } from '../storage/provider'

const props = defineProps<{
  session: Session
  storage: StorageProvider
  messageId: string
  /** 宛先をこの人たちに絞る。締切のリマインドで使う (原稿 07)。 */
  onlyUserIds?: string[]
}>()
const emit = defineEmits<{ close: [] }>()

const batches = ref<MailBatch[]>([])
/** push の結果。関数を置いていないグループでは null のまま。 */
const pushResult = ref<{ sent: number; ok: boolean } | null>(null)
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

    // 関数を置いているなら先に起こす。届いた人はメールから外す (設計書 §9.1)。
    // push はスコープ単位でしか送れないので、宛先を絞るリマインドでは使わない。
    const notified = props.onlyUserIds
      ? []
      : await wakeSubscribers(message?.scopes ?? [], settings.notifications.functionToken)

    const audience = resolveAudience({
      roster: props.session.roster,
      contacts,
      settings: settings.notifications,
      scopes: message?.scopes ?? [],
      excludeUserId: props.session.userId,
    })
    const only = props.onlyUserIds
    missingEmail.value = only
      ? audience.missingEmail.filter((userId) => only.includes(userId))
      : audience.missingEmail

    batches.value = buildMailBatches({
      recipients: audience.reachable
        .filter((person) => !notified.includes(person.userId))
        .filter((person) => !only || only.includes(person.userId)),
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

/**
 * 通知用の関数へ「起こして」と頼む。落ちていても投稿は済んでいるので、
 * 例外にせずメールへ落とす。
 */
async function wakeSubscribers(scopes: string[], token: string): Promise<string[]> {
  let functionUrl: string | null = null
  try {
    functionUrl = decodeManifest(
      await props.storage.get(manifestPath(props.session.groupId)),
    ).functionUrl
  } catch {
    functionUrl = null
  }
  if (!functionUrl || token === '') return []

  const health = await checkFunction(functionUrl)
  if (!health.ok) {
    pushResult.value = { sent: 0, ok: false }
    return []
  }

  const result = await notifyScopes({
    functionUrl,
    token,
    groupId: props.session.groupId,
    scopes,
  })
  pushResult.value = { sent: result.sent, ok: true }
  return result.notified
}

async function markSent(batch: MailBatch): Promise<void> {
  sent.value = { ...sent.value, [batch.index]: true }
  await markBatchSent({ db, messageId: props.messageId, batchIndex: batch.index })
}
</script>

<template>
  <section v-if="loaded" data-test="ready">
    <h1>{{ onlyUserIds ? 'まだ回答していない方へ知らせる' : 'メールで知らせる' }}</h1>
    <AppBar title="通知の送信">
      <template #left>
        <button type="button" class="quiet" data-test="close" @click="emit('close')">閉じる</button>
      </template>
    </AppBar>

    <p>
      リンクを押すとメールアプリが開きます。送信そのものはアプリからは
      <strong>自動では確認できません</strong>ので、送り終えたら「送った」を押してください。
    </p>
    <p>宛先は BCC に入っています。参加者どうしにアドレスは見えません。</p>
    <p v-if="onlyUserIds" class="hint">
      通知 (push) は宛先を選べないため、リマインドはメールだけで送ります。
    </p>

    <p v-if="pushResult" data-test="push-result">
      {{
        pushResult.ok
          ? `通知を ${pushResult.sent} 件送りました。届いた方はメールの相手から外しています。`
          : '通知の関数につながらなかったため、push は届きません。メールで知らせてください。'
      }}
    </p>

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
