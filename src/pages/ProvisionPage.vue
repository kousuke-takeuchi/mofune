<script setup lang="ts">
import { useRouter } from 'vue-router'
import ProvisionWizardView from '../ui/ProvisionWizardView.vue'

const router = useRouter()

/**
 * 刷ったばかりの接続コードを打ち直させない。コードは秘密ではなく (QR で配るもの)、
 * 開設した本人が最初のログインで使うものなので、そのまま渡す。
 */
function toLogin(connectionCode: string): void {
  void router.push({ name: 'login', query: { c: connectionCode } })
}
</script>

<template>
  <ProvisionWizardView @done="toLogin" @cancel="router.push({ name: 'login' })" />
</template>
