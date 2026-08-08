<script setup lang="ts">
import { ref } from 'vue'
import AppBar from './AppBar.vue'
import { utf8 } from '../crypto/bytes'
import type { KdfParams } from '../crypto/kdf'
import { openGroupDatabase } from '../db/group-db'
import { buildPasswordChange } from '../group/password-change'
import type { Session } from '../group/session'
import { readGrant } from '../inbox/grants'
import { submitDirectly, submitToInbox } from '../inbox/submit'
import type { StorageProvider } from '../storage/provider'
import { flushOutbox } from '../sync/outbox'

/**
 * 参加者が自分のパスワードを決め直す (原稿 12)。
 *
 * QR を読むだけで入れる紙を配る運用では、最初のパスワードは紙に書かれたもの
 * のままになる。本人が変えられないと、紙を見た人が入り続けられてしまう。
 *
 * 参加者は置き場へ書けないので、包み直したキーストアを受信箱へ投函し、
 * 担当者が受け取って置き場へ移す。切り替わるのはそのときで、それまでは
 * いまのパスワードで入る。
 */
const props = defineProps<{
  session: Session
  storage: StorageProvider
  /** ログインに使っているアドレス。置き場所を決める。 */
  email: string
  /** 接続コードが運ぶ pepper。 */
  pepper: string
  kdf?: KdfParams
}>()

const next = ref('')
const again = ref('')
const busy = ref(false)
const error = ref('')
const done = ref(false)

const db = openGroupDatabase(props.session.groupId)

async function save(): Promise<void> {
  error.value = ''
  if (next.value !== again.value) {
    error.value = '2つのパスワードが一致しません'
    return
  }
  busy.value = true
  try {
    const change = await buildPasswordChange({
      session: props.session,
      email: props.email,
      newPassword: next.value,
      pepper: props.pepper,
      ...(props.kdf ? { kdf: props.kdf } : {}),
    })
    const plaintext = utf8(JSON.stringify(change))

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
      throw new Error('いまは送れません。担当者がアプリを開くまでお待ちください。')
    }
    await flushOutbox({ db, storage: props.storage })
    next.value = ''
    again.value = ''
    done.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'パスワードを変えられませんでした'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section>
    <AppBar title="パスワードを変える" />

    <p v-if="done" data-test="done">
      新しいパスワードを送りました。担当者が受け取ると切り替わります。
      それまでは、いまのパスワードでお入りください。
    </p>

    <template v-else>
      <p class="hint">
        紙に書かれた最初のパスワードは、紙を見た人にも分かります。自分だけが知る
        ものへ変えてください。8文字以上です。
      </p>

      <label>
        新しいパスワード
        <input
          type="password"
          data-test="new-password"
          v-model="next"
          autocomplete="new-password"
        />
      </label>
      <label>
        もう一度
        <input type="password" data-test="again" v-model="again" autocomplete="new-password" />
      </label>

      <p v-if="error" data-test="error">{{ error }}</p>

      <div class="sticky-actions">
        <button type="button" class="primary" data-test="save" :disabled="busy" @click="save">
          {{ busy ? '送っています…' : 'このパスワードにする' }}
        </button>
      </div>
    </template>
  </section>
</template>
