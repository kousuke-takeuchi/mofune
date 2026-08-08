<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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
const agreed = ref(false)

/** 1 接続 → 2 メールの登録 → 3 届くかどうかの確認 (原稿 02)。 */
const STEPS = [1, 2, 3]
const step = computed(() => (registered.value ? 3 : 2))

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
    <div class="steps" data-test="step">
      <p>{{ step }} / {{ STEPS.length }}</p>
      <div class="step-bar">
        <span
          v-for="value in STEPS"
          :key="value"
          data-test="step-segment"
          :data-done="String(value <= step)"
        />
      </div>
    </div>

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

    <label class="agree">
      <input type="checkbox" data-test="agree" v-model="agreed" />
      <a href="/privacy.html" target="_blank" rel="noopener">プライバシーポリシー</a>に同意します
    </label>

    <p v-if="error" data-test="error">{{ error }}</p>

    <div v-if="registered" class="check-card">
      <h2>届くかどうかの確認</h2>
      <p>
        担当者がテスト通知を送ります。届いたら下のボタンを押してください。
      </p>
      <button type="button" data-test="confirm" @click="confirm">
        テスト通知が届きました
      </button>
    </div>

    <!-- grant を読み終えるまで押させない。押せても失敗するだけで分かりにくい。 -->
    <div class="sticky-actions">
      <button
        type="button"
        class="primary"
        data-test="register"
        :disabled="busy || !loaded || !agreed"
        @click="register"
      >
        登録する
      </button>
    </div>
  </section>
</template>
