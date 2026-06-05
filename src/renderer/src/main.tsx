import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { ThemeProvider } from './components/Theme/ThemeProvider'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'

const root = ReactDOM.createRoot(document.getElementById('root')!)

if (window.location.hash === '#voice-widget') {
  // Mode WIDGET flottant : fond 100% transparent (index.css met var(--bg) sur html/body/#root → on l'écrase).
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  document.getElementById('root')!.style.background = 'transparent'
  void import('./components/Voice/VoiceWidget').then(({ VoiceWidget }) =>
    root.render(
      <ThemeProvider>
        <VoiceWidget />
      </ThemeProvider>,
    ),
  )
} else {
  // App principale (chargée à la demande pour garder le widget léger).
  void Promise.all([import('./lib/monaco-setup'), import('./App')]).then(([, app]) =>
    root.render(
      <React.StrictMode>
        {/* reducedMotion="user" : motion (JS) respecte prefers-reduced-motion, comme le fait déjà le CSS. */}
        <MotionConfig reducedMotion="user">
          <ThemeProvider>
            <ErrorBoundary label="Oryon">
              <app.default />
            </ErrorBoundary>
          </ThemeProvider>
        </MotionConfig>
      </React.StrictMode>,
    ),
  )
}
