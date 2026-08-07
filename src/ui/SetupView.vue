<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { openGroupDatabase } from '../db/group-db'
import {
  buildEmailRegistration,
  markEmailConfirmed,
  sendEmailRegistration,
} from '../group/email-registration'
import type { Session } from '../group/session'
import type { InboxGrant } from '../inbox/grants'
import { readGrant } from '../inbox/grants'
import type { StorageProvider } from '../storage/provider'
import { flushOutbox } from '../sync/outbox'

const props = defineProps<{ session: Session; storage: StorageProvider }>()
const emit = defineEmits<{ done: [] }>()

const grant = ref<InboxGrant | null>(null)
const loaded = ref(false)
const email = ref('')
const registered = ref(false)
const error = ref('')
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

async function register(): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    if (!grant.value) {
      throw new Error('いまは登録できません。担当者がアプリを開くまでお待ちください。')
    }
    const registration = buildEmailRegistration({ session: props.session, email: email.value })
    await sendEmailRegistration({
      session: props.session,
      db,
      grant: grant.value,
      registration,
    })
    await flushOutbox({ db, storage: props.storage })
    registered.value = true
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'メールアドレスを登録できませんでした'
  } finally {
    busy.value = false
  }
}

async function confirm(): Promise<void> {
  await markEmailConfirmed(db)
  emit('done')
}
</script>

<template>
  <section>
    <h1>はじめの設定</h1>
    <p>
      メールアドレスを登録してください。お知らせの通知先として必要です。
      登録が済むまで、お知らせの閲覧はロックされています。
    </p>
    <p>登録したアドレスは担当者と管理者だけが見られます。ほかの参加者には表示されません。</p>

    <label>
      メールアドレス
      <input type="email" data-test="email" v-model="email" />
    </label>

    <p v-if="error" data-test="error">{{ error }}</p>

    <!-- grant を読み終えるまで押させない。押せても失敗するだけで分かりにくい。 -->
    <button type="button" data-test="register" :disabled="busy || !loaded" @click="register">
      登録する
    </button>

    <div v-if="registered">
      <p>
        届くかどうかの確認をします。担当者がテスト通知を送ります。
        届いたら下のボタンを押してください。
      </p>
      <button type="button" data-test="confirm" @click="confirm">
        テスト通知が届きました
      </button>
    </div>
  </section>
</template>
