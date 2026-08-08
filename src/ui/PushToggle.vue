<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { utf8 } from '../crypto/bytes'
import { openGroupDatabase } from '../db/group-db'
import { decodeManifest } from '../group/manifest'
import type { Session } from '../group/session'
import { readGrant } from '../inbox/grants'
import { submitDirectly, submitToInbox } from '../inbox/submit'
import { buildPushRegistration } from '../notify/push'
import type { PushSubscriptionRecord } from '../notify/push'
import { checkFunction } from '../notify/push'
import { subscribeThisDevice } from '../notify/subscribe'
import type { StorageProvider } from '../storage/provider'
import { manifestPath } from '../storage/paths'
import { flushOutbox } from '../sync/outbox'

const props = defineProps<{
  session: Session
  storage: StorageProvider
  /** テストから差し替える。既定はこの端末のブラウザに訊く。 */
  subscribe?: (options: { vapidPublicKey: string }) => Promise<PushSubscriptionRecord>
}>()

const loaded = ref(false)
const vapidPublicKey = ref('')
/** 関数を置いていない / つながらない、のどちらかを伝える文言。 */
const unavailable = ref('')
const busy = ref(false)
const done = ref(false)
const error = ref('')

const db = openGroupDatabase(props.session.groupId)

onMounted(async () => {
  try {
    const manifest = decodeManifest(await props.storage.get(manifestPath(props.session.groupId)))
    if (!manifest.functionUrl) {
      unavailable.value = 'このグループでは通知を使っていません。お知らせはメールで届きます。'
      return
    }
    const health = await checkFunction(manifest.functionUrl)
    if (!health.ok || !health.vapidPublicKey) {
      unavailable.value = 'いま通知の窓口につながりません。しばらくしてからお試しください。'
      return
    }
    vapidPublicKey.value = health.vapidPublicKey
  } catch {
    unavailable.value = 'いま通知の窓口につながりません。しばらくしてからお試しください。'
  } finally {
    loaded.value = true
  }
})

/**
 * 購読を担当者へ届ける。関数の URL も合言葉も参加者には渡さない。
 * 届け先は inbox で、担当者が回収して関数へ渡す (設計書 §9.3)。
 */
async function turnOn(): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    const subscribe = props.subscribe ?? subscribeThisDevice
    const subscription = await subscribe({ vapidPublicKey: vapidPublicKey.value })
    const registration = buildPushRegistration({ session: props.session, subscription })
    const plaintext = utf8(JSON.stringify(registration))

    const grant = await readGrant({
      storage: props.storage,
      groupId: props.session.groupId,
      userId: props.session.userId,
      ecdhPrivate: props.session.ecdhPrivate,
    }).catch(() => null)

    if (grant) {
      await submitToInbox({ session: props.session, db, grant, plaintext })
    } else if (props.storage.capabilities.write) {
      await submitDirectly({ session: props.session, db, plaintext })
    } else {
      throw new Error('いまは登録できません。担当者がアプリを開くまでお待ちください。')
    }
    await flushOutbox({ db, storage: props.storage })
    done.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '通知を受け取れるようにできませんでした'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="loaded" data-test="push-ready">
    <p v-if="unavailable" class="hint" data-test="push-unavailable">{{ unavailable }}</p>

    <template v-else>
      <p v-if="done" data-test="push-done">
        この端末で通知を受け取ります。担当者が次にアプリを開いたときから届きはじめます。
      </p>
      <template v-else>
        <p class="hint">
          通知に本文は載りません。「新しい連絡があります」とだけ出ます。
        </p>
        <button type="button" data-test="push-subscribe" :disabled="busy" @click="turnOn">
          {{ busy ? '登録しています…' : 'この端末で通知を受け取る' }}
        </button>
      </template>
      <p v-if="error" data-test="push-error">{{ error }}</p>
    </template>
  </div>
</template>
