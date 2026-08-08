<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { readQrFromFrame } from '../qr/decode'

/**
 * 紙の QR をアプリの中で読む。
 *
 * 端末のカメラアプリで読んでも同じことができるが、アプリを開いたあとで
 * 「読み取る」に進める道が無いと、PC の人や案内を見落とした人が長い
 * 接続コードを手で打つことになる。
 *
 * 読み取りの本体は `src/qr/decode.ts` に分けてある。ここはカメラの扱いと
 * 後始末だけを持つ。差し替えられるようにしているのは、カメラの無い環境
 * (テスト) でも中身を確かめられるようにするため。
 */
const props = withDefaults(
  defineProps<{
    /** 1コマから文字を取り出す。既定は同梱の読み取り器。 */
    decode?: (canvas: HTMLCanvasElement, video: HTMLVideoElement) => string | null
    /** 何ミリ秒ごとに1コマ見るか。 */
    intervalMs?: number
  }>(),
  { decode: undefined, intervalMs: 120 },
)
const emit = defineEmits<{ read: [text: string]; close: [] }>()

const video = ref<HTMLVideoElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const error = ref('')

let stream: MediaStream | null = null
let timer: ReturnType<typeof setInterval> | null = null
let done = false

function stopCamera(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  for (const track of stream?.getTracks() ?? []) track.stop()
  stream = null
}

function look(): void {
  if (done || !canvas.value || !video.value) return
  const decode = props.decode ?? readQrFromFrame
  let text: string | null = null
  try {
    text = decode(canvas.value, video.value)
  } catch {
    // 1コマ読めなくても次のコマで拾えばよい
    text = null
  }
  if (text === null || text === '') return
  // 同じ紙を二度渡さない
  done = true
  stopCamera()
  emit('read', text)
}

onMounted(async () => {
  const media = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices
  if (!media?.getUserMedia) {
    error.value =
      'このブラウザではカメラを使えません。端末のカメラアプリで QR を読み取ってください。'
    return
  }
  try {
    // 紙に向けるのは背面のカメラ
    stream = await media.getUserMedia({ video: { facingMode: 'environment' } })
  } catch {
    error.value =
      'カメラを使えませんでした。許可されていない場合は、端末の設定から許可してください。'
    return
  }
  // 映像の受け渡しは環境差が大きい。ここで転んでも読み取りは続けさせる
  try {
    if (video.value) {
      video.value.srcObject = stream
      await video.value.play?.()
    }
  } catch {
    // 自動再生を断られても、コマは取れることがある
  }
  timer = setInterval(look, props.intervalMs)
  // 刻みが 0 のときは待たずに1度見る (テスト用)
  if (props.intervalMs === 0) look()
})

onBeforeUnmount(stopCamera)

function close(): void {
  stopCamera()
  emit('close')
}
</script>

<template>
  <div class="scanner">
    <p v-if="error" data-test="scanner-error">{{ error }}</p>
    <template v-else>
      <video ref="video" data-test="scanner-video" playsinline muted></video>
      <p class="hint">紙の QR コードを枠の中に入れてください。</p>
    </template>
    <canvas ref="canvas" class="hidden-canvas"></canvas>
    <button type="button" class="quiet" data-test="close-scanner" @click="close">やめる</button>
  </div>
</template>
