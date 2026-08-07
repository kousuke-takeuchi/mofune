<script setup lang="ts">
import { useRouter } from 'vue-router'
import ProvisionWizardView from '../ui/ProvisionWizardView.vue'

const router = useRouter()
</script>

<template>
  <ProvisionWizardView
    @done="router.push({ name: 'login' })"
    @cancel="router.push({ name: 'login' })"
  />
</template>
