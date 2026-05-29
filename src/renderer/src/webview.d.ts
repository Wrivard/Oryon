import type { DetailedHTMLProps, HTMLAttributes } from 'react'

// Élément <webview> d'Electron (preview localhost du panneau Browser).
declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string
          allowpopups?: string
          partition?: string
        },
        HTMLElement
      >
    }
  }
}

export {}
