// Configure Monaco pour Vite/Electron : workers bundlés localement (offline-safe)
// + thème accordé au design system + loader pointant sur le monaco local (pas de CDN).
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { loader } from '@monaco-editor/react'

const env: monaco.Environment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  },
}
;(globalThis as typeof globalThis & { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = env

monaco.editor.defineTheme('oryon-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#141414',
    'editor.foreground': '#ededed',
    'editorLineNumber.foreground': '#3a3a3a',
    'editorLineNumber.activeForeground': '#a0a0a0',
    'editor.selectionBackground': '#00e59933',
    'editorCursor.foreground': '#00e599',
    'editor.lineHighlightBackground': '#1c1c1c',
    'editorGutter.background': '#141414',
    'editorWidget.background': '#1f1f1f',
    'editorWidget.border': '#2a2a2a',
    'input.background': '#161616',
    'focusBorder': '#00e59955',
    'editorIndentGuide.background1': '#242424',
  },
})

loader.config({ monaco })

export { monaco }
