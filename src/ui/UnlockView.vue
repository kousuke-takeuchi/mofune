<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ groupName: string; loginId: string; busy: boolean; error: string }>()
const emit = defineEmits<{ unlock: [password: string]; switchGroup: []; forget: [] }>()

const password = ref('')
</script>

<template>
  <section>
    <h1>おかえりなさい</h1>
    <p>{{ groupName }} — {{ loginId }}</p>

    <label>
      パスワード
      <input
        v-model="password"
        data-test="password"
        type="password"
        autocomplete="current-password"
      />
    </label>

    <p v-if="error" data-test="error" role="alert">{{ error }}</p>

    <button type="button" data-test="unlock" :disabled="busy" @click="emit('unlock', password)">
      {{ busy ? '確認しています…' : '開く' }}
    </button>

    <button type="button" data-test="switch-group" @click="emit('switchGroup')">
      別のグループに入る
    </button>
    <button type="button" data-test="forget" @click="emit('forget')">
      この端末の記録を消す
    </button>
  </section>
</template>
