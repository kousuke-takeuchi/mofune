<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { Bytes } from '../crypto/bytes'
import { keyId } from '../crypto/keyring'
import { STAFF_SCOPE } from '../crypto/roster'
import type { Session } from '../group/session'
import AppBar from './AppBar.vue'
import type { StorageSettings } from '../group/storage-credentials'
import { readStorageSettings } from '../group/storage-credentials'
import { readGroupSettings } from '../group/group-settings'
import { updateContacts } from '../group/roster-update'
import { applyInbox } from '../inbox/apply'
import { decodeManifest } from '../group/manifest'
import { manifestPath } from '../storage/paths'
import { pushRegistryFrom, replaceRegistry } from '../notify/push'
import { publishGrants } from '../inbox/grants'
import type { StorageProvider } from '../storage/provider'

const props = defineProps<{
  session: Session
  storage: StorageProvider
  adminPublicKey: Bytes
}>()
const emit = defineEmits<{ close: [] }>()

const settings = ref<StorageSettings | null>(null)
const loaded = ref(false)
const busy = ref(false)
const error = ref('')
const grantsIssued = ref<number | null>(null)
const appliedAbsences = ref<number | null>(null)
const needsAdmin = ref(false)
const notificationToken = ref('')
const pushHandedOver = ref<number | null>(null)
const pushProblem = ref('')

onMounted(async () => {
  try {
    settings.value = await readStorageSettings({
      storage: props.storage,
      groupId: props.session.groupId,
      keys: props.session.groupKeys,
    })
  } catch {
    // 参加者向けの読み取り専用プロバイダでは資格情報を読めない
    settings.value = null
  }
  try {
    const staffKey = props.session.groupKeys.get(keyId(STAFF_SCOPE, 1))
    if (staffKey) {
      const group = await readGroupSettings({
        storage: props.storage,
        groupId: props.session.groupId,
        staffKey,
      })
      notificationToken.value = group.notifications.functionToken
    }
  } catch {
    notificationToken.value = ''
  } finally {
    loaded.value = true
  }
})

async function publish(): Promise<void> {
  if (!settings.value) return
  error.value = ''
  busy.value = true
  try {
    const issued = await publishGrants({
      storage: props.storage,
      groupId: props.session.groupId,
      roster: props.session.roster,
      settings: settings.value,
    })
    grantsIssued.value = issued.length
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '投函枠を配れませんでした'
  } finally {
    busy.value = false
  }
}

/**
 * 集めた購読を関数へ渡す。関数を置いていないグループでは何もしない。
 * 名簿はまるごと差し替えるので、渡すのは「いま手元にある全部」でなければならない。
 */
async function handOverSubscriptions(
  registrations: Awaited<ReturnType<typeof applyInbox>>['pendingPushRegistrations'],
): Promise<boolean> {
  pushProblem.value = ''
  let functionUrl: string | null = null
  try {
    functionUrl = decodeManifest(
      await props.storage.get(manifestPath(props.session.groupId)),
    ).functionUrl
  } catch {
    functionUrl = null
  }
  if (!functionUrl || notificationToken.value === '') {
    pushProblem.value =
      '通知の関数が設定されていないため、届いた購読はそのまま残しました。グループの設定で関数を登録してください。'
    return false
  }

  try {
    await replaceRegistry({
      functionUrl,
      token: notificationToken.value,
      groupId: props.session.groupId,
      registry: pushRegistryFrom(registrations),
    })
  } catch {
    pushProblem.value = '通知の関数へ購読を渡せませんでした。購読はそのまま残しています。'
    return false
  }
  pushHandedOver.value = registrations.length
  return true
}

async function process(): Promise<void> {
  error.value = ''
  needsAdmin.value = false
  busy.value = true
  try {
    const result = await applyInbox({ storage: props.storage, session: props.session })
    appliedAbsences.value = result.absences

    // 購読は関数へ渡してから消す。渡す前に消すと二度と戻せない
    if (result.pendingPushRegistrations.length > 0) {
      const handed = await handOverSubscriptions(result.pendingPushRegistrations)
      if (handed) await result.discardPush()
    }

    if (result.pendingContactUpdates.length === 0) return

    if (props.session.role !== 'admin') {
      // 名簿の再署名は管理者だけができる(信頼の根を持つのが管理者だけのため)
      needsAdmin.value = true
      return
    }
    const staffKey = props.session.groupKeys.get(keyId(STAFF_SCOPE, 1))
    if (!staffKey) throw new Error('staff スコープ鍵がありません')
    await updateContacts({
      storage: props.storage,
      session: props.session,
      adminPublicKey: props.adminPublicKey,
      staffKey,
      generation: 1,
      updates: result.pendingContactUpdates,
    })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '受信を処理できませんでした'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="loaded">
    <AppBar title="受信と配布">
      <template #left>
        <button type="button" class="quiet" data-test="close" @click="emit('close')">閉じる</button>
      </template>
    </AppBar>

    <p v-if="!settings" data-test="no-credentials">
      このグループの書き込み設定を読めませんでした。管理者が開設ウィザードで設定するまで、
      投函枠の配布と受信の処理はできません。
    </p>

    <div v-else data-test="ready">
      <p v-if="pushHandedOver !== null" data-test="push-handed-over">
        通知の購読を {{ pushHandedOver }} 件、関数へ渡しました。
      </p>
      <p v-if="pushProblem" data-test="push-problem">{{ pushProblem }}</p>

      <button type="button" data-test="publish-grants" :disabled="busy" @click="publish">
        投函枠を配る
      </button>
      <p v-if="grantsIssued !== null" data-test="grants-issued">
        {{ grantsIssued }} 名に配りました
      </p>

      <button type="button" data-test="process-inbox" :disabled="busy" @click="process">
        受信を処理する
      </button>
      <p v-if="appliedAbsences !== null" data-test="applied-absences">
        不在連絡 {{ appliedAbsences }} 件を反映しました
      </p>
      <p v-if="needsAdmin" data-test="needs-admin">
        メールアドレスの登録が届いています。名簿への反映は管理者が行ってください。
      </p>

      <p v-if="error" data-test="error">{{ error }}</p>
    </div>
  </section>
</template>
