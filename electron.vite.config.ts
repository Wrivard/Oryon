import { resolve } from 'path'
import { copyFileSync, mkdirSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Copie le runtime ONNX (Transformers.js/Whisper) en LOCAL (même origine). Sans ça, Transformers.js v4
// pointe wasmPaths vers une version -dev d'onnxruntime-web absente du CDN jsDelivr → 404 → « Can't create
// a session ». buildStart tourne en dev (serve) ET au build → les fichiers existent toujours et matchent
// la version installée. Ils atterrissent à <web root>/ort/ (dev) et out/renderer/ort/ (prod).
const ORT_DIST = resolve('node_modules/onnxruntime-web/dist')
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']

function copyOrtWasm() {
  return {
    name: 'copy-ort-wasm',
    buildStart() {
      const dest = resolve('src/renderer/public/ort')
      mkdirSync(dest, { recursive: true })
      for (const f of ORT_FILES) copyFileSync(resolve(ORT_DIST, f), resolve(dest, f))
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), copyOrtWasm()]
  }
})
