<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <!--
    画面の上に貼り付く帯。戻る操作は画面ごとに意味が違う (戻る / 閉じる /
    キャンセル) ので、バーは場所だけ用意して中身は呼び出し側に任せる。
  -->
  <header class="app-bar">
    <div class="app-bar-left"><slot name="left" /></div>
    <h1>{{ title }}</h1>
    <div class="app-bar-right"><slot name="right" /></div>
  </header>
</template>
