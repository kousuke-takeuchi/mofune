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
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />
      </svg>
      ホーム
    </button>
    <button
      type="button"
      data-test="nav-absence"
      :aria-current="active === 'absence' ? 'page' : undefined"
      @click="emit('go', 'absence')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.5" y="5" width="17" height="15" rx="3" />
        <path d="M8 3v4M16 3v4M3.5 10h17" />
      </svg>
      れんらく
    </button>
    <button
      type="button"
      data-test="nav-menu"
      :aria-current="active === 'menu' ? 'page' : undefined"
      @click="emit('go', 'menu')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
      メニュー
    </button>
  </nav>
</template>
