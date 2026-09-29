import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  // relative asset URLs, so the build works under any path (e.g. GitHub Pages' /<repo>/)
  base: './',
  build: {
    rollupOptions: {
      // render.html hosts the offline renderer (see src/music/render.ts)
      input: { main: 'index.html', render: 'render.html' },
    },
  },
})
