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
 * カメラは画面を覆って出す。ページの流れの中に埋めると、映像が小さくなり
 * 紙を合わせづらい。**読み取りに使う canvas は DOM へ置かない**。置くと
 * 最後のコマがそのまま残って、映像が2つ並んでいるように見える。
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
const error = ref('')
const read = ref(false)

/** 画素を読むための作業台。画面には出さない。 */
const canvas = document.createElement('canvas')

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
  if (done || !video.value) return
  const decode = props.decode ?? readQrFromFrame
  let text: string | null = null
  try {
    text = decode(canvas, video.value)
  } catch {
    // 1コマ読めなくても次のコマで拾えばよい
    text = null
  }
  if (text === null || text === '') return
  // 同じ紙を二度渡さない
  done = true
  read.value = true
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
  <div class="scanner-backdrop" @click.self="close">
    <div class="scanner-panel" data-test="scanner-modal" role="dialog" aria-modal="true">
      <header class="scanner-head">
        <h2>QRコードを読み取る</h2>
        <button type="button" class="quiet" data-test="close-scanner" @click="close">閉じる</button>
      </header>

      <p v-if="error" data-test="scanner-error">{{ error }}</p>

      <div v-else class="scanner-stage">
        <video ref="video" data-test="scanner-video" playsinline muted></video>
        <!-- 状態は映像の上に重ねる。下に置くと画面が縦に伸びて映像が小さくなる -->
        <p class="scanner-state" data-test="scanner-state">
          {{ read ? '読み取りました' : '紙の QR コードを枠の中に入れてください' }}
        </p>
        <div class="scanner-frame" aria-hidden="true"></div>
      </div>
    </div>
  </div>
</template>
