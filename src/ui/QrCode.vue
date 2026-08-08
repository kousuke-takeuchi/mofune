<script setup lang="ts">
import { computed } from 'vue'
import qrcode from 'qrcode-generator'

const props = withDefaults(
  defineProps<{ text: string; label?: string; correction?: 'L' | 'M' | 'Q' | 'H' }>(),
  { label: 'QRコード', correction: 'M' },
)

interface Rendered {
  count: number
  /** 塗るマスの座標。1マス1px として viewBox で拡大する。 */
  dark: Array<{ x: number; y: number }>
}

/**
 * 紙に印刷して読み取らせる。型番は 0 (自動) にして、入る大きさまで勝手に上げる。
 * 固定すると長い接続コードで例外になる。
 */
const rendered = computed<Rendered | null>(() => {
  if (props.text.length === 0) return null
  const qr = qrcode(0, props.correction)
  qr.addData(props.text)
  qr.make()

  const count = qr.getModuleCount()
  const dark: Array<{ x: number; y: number }> = []
  for (let y = 0; y < count; y += 1) {
    for (let x = 0; x < count; x += 1) {
      if (qr.isDark(y, x)) dark.push({ x, y })
    }
  }
  return { count, dark }
})
</script>

<template>
  <figure v-if="rendered" class="qr">
    <svg
      :viewBox="`0 0 ${rendered.count} ${rendered.count}`"
      role="img"
      :aria-label="label"
      shape-rendering="crispEdges"
    >
      <rect :width="rendered.count" :height="rendered.count" fill="#FFFFFF" />
      <rect
        v-for="(module, index) in rendered.dark"
        :key="index"
        :x="module.x"
        :y="module.y"
        width="1"
        height="1"
        fill="#3B322A"
      />
    </svg>
    <figcaption>{{ label }}</figcaption>
  </figure>
</template>
