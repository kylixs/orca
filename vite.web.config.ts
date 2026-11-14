import { markdownParserAliases } from './config/build-plugins/markdown-parser-exports'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createPdfjsViewerAssetsPlugin } from './config/build-plugins/pdfjs-viewer-assets'

export default defineConfig({
  root: resolve('src/renderer'),
  // Why: pairing URLs may live under a reverse-proxy path prefix like
  // /orca/web-index.html, so built assets must resolve relative to the page.
  base: './',
  plugins: [react(), tailwindcss(), createPdfjsViewerAssetsPlugin()],
  define: {
    ORCA_FEATURE_WALL_ENABLED: 'true'
  },
  resolve: {
    alias: {
      ...markdownParserAliases,
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  },
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    rollupOptions: {
      // Why both: verify-web-build checks every entry the host serves under the
      // shared static root, and this build must produce the same set.
      input: {
        web: resolve('src/renderer/web-index.html'),
        'cloud-admin': resolve('src/renderer/cloud-admin.html')
      }
    }
  },
  worker: {
    format: 'es'
  }
})
