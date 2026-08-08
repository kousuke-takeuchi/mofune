<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PasswordChangeView from '../ui/PasswordChangeView.vue'
import { getGroup } from '../db/groups'
import { useSessionStore } from '../stores/session'

const router = useRouter()
const session = useSessionStore()

/** pepper と自分のアドレスは端末に残っている接続コードから取る。 */
const pepper = ref('')
const email = ref('')

onMounted(async () => {
  const groupId = session.groupId
  if (!groupId) return
  const stored = await getGroup(groupId)
  if (!stored) return
  pepper.value = stored.code.pepper
  email.value = stored.email
})
</script>

<template>
  <PasswordChangeView
    v-if="session.session && session.storage && pepper && email"
    :session="session.session"
    :storage="(session.writer ?? session.storage)!"
    :email="email"
    :pepper="pepper"
  />
  <button
    type="button"
    class="wide"
    data-test="back"
    @click="router.push({ name: 'settings', params: { groupId: session.groupId } })"
  >
    設定へ戻る
  </button>
</template>
