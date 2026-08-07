<script setup lang="ts">
export type NavPlace = 'home' | 'absence' | 'menu'

defineProps<{ active: NavPlace }>()
const emit = defineEmits<{ go: [place: NavPlace] }>()
</script>

<template>
  <nav class="bottom-nav">
    <button
      type="button"
      data-test="nav-home"
      :aria-current="active === 'home' ? 'page' : undefined"
      @click="emit('go', 'home')"
    >
      ホーム
    </button>
    <button
      type="button"
      data-test="nav-absence"
      :aria-current="active === 'absence' ? 'page' : undefined"
      @click="emit('go', 'absence')"
    >
      れんらく
    </button>
    <button
      type="button"
      data-test="nav-menu"
      :aria-current="active === 'menu' ? 'page' : undefined"
      @click="emit('go', 'menu')"
    >
      メニュー
    </button>
  </nav>
</template>
