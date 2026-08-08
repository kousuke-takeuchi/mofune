<script setup lang="ts">
import { useRouter } from 'vue-router'
import RecoverView from '../ui/RecoverView.vue'

const router = useRouter()

/** 作り直したら、そのコードを入れた状態のログイン画面へ送る。 */
function onRestored(connectionCode: string): void {
  void router.push({ name: 'login', query: { c: connectionCode } })
}
</script>

<template>
  <RecoverView @back="router.back()" @restored="onRestored" />
</template>
