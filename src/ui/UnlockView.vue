<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ groupName: string; email: string; busy: boolean; error: string }>()
const emit = defineEmits<{ unlock: [password: string]; switchGroup: []; forget: [] }>()

const password = ref('')
</script>

<template>
  <section>
    <div class="brand">
      <svg viewBox="0 0 200 190" aria-hidden="true">
        <ellipse cx="100" cy="152" rx="60" ry="10" fill="#3B322A" opacity=".07" />
        <circle cx="58" cy="82" r="26" fill="#FFFFFF" />
        <circle cx="142" cy="82" r="26" fill="#FFFFFF" />
        <circle cx="78" cy="52" r="26" fill="#FFFFFF" />
        <circle cx="124" cy="50" r="24" fill="#FFFFFF" />
        <ellipse cx="100" cy="92" rx="54" ry="48" fill="#FFFFFF" />
        <ellipse cx="100" cy="139" rx="46" ry="16" fill="#E8A03C" />
        <rect x="54" y="112" width="92" height="26" rx="13" fill="#E8A03C" />
        <path d="M74 88 q8 -9 16 0" stroke="#3B322A" stroke-width="4" fill="none" stroke-linecap="round" />
        <path d="M110 88 q8 -9 16 0" stroke="#3B322A" stroke-width="4" fill="none" stroke-linecap="round" />
        <ellipse cx="64" cy="103" rx="9" ry="6" fill="#F2A28C" opacity=".75" />
        <ellipse cx="136" cy="103" rx="9" ry="6" fill="#F2A28C" opacity=".75" />
        <path d="M92 100 q8 8 16 0" stroke="#3B322A" stroke-width="3.4" fill="none" stroke-linecap="round" />
      </svg>
      <h1>おかえりなさい</h1>
      <p class="hint">{{ groupName }} — {{ email }}</p>
    </div>

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

    <button type="button" class="primary" data-test="unlock" :disabled="busy" @click="emit('unlock', password)">
      {{ busy ? '確認しています…' : '開く' }}
    </button>

    <button type="button" class="quiet" data-test="switch-group" @click="emit('switchGroup')">
      別のグループに入る
    </button>
    <button type="button" class="quiet danger" data-test="forget" @click="emit('forget')">
      この端末の記録を消す
    </button>
  </section>
</template>
