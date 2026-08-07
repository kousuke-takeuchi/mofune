import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // PWA は mofune.site/app/ で配信する(設計書 §13)。ルートは紹介ページ用に空けておく。
  base: '/app/',
  plugins: [vue()],
  build: {
    outDir: 'site/app',
    emptyOutDir: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
