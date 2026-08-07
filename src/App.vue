<script setup lang="ts">
import { ref } from 'vue'
import LoginView from './ui/LoginView.vue'
import type { Session } from './group/session'

const session = ref<Session | null>(null)

function onLogin(next: Session): void {
  session.value = next
}
</script>

<template>
  <main>
    <LoginView v-if="!session" @login="onLogin" />
    <section v-else>
      <h1>{{ session.groupName }}</h1>
      <p>{{ session.displayName }} さんとしてログインしています（{{ session.role }}）</p>
      <p>利用できる鍵: {{ [...session.groupKeys.keys()].join(', ') }}</p>
    </section>
  </main>
</template>
