import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react'
import { applyTheme, themes, DEFAULT_THEME_ID, type Theme } from './themes'

interface ThemeContextValue {
  theme: Theme
  setThemeId: (id: string) => void
  available: Theme[]
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const STORAGE_KEY = 'oryon:theme'

function initialThemeId(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && themes[saved]) return saved
  } catch {
    /* localStorage indispo */
  }
  return DEFAULT_THEME_ID
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeIdState] = useState<string>(initialThemeId)
  const theme = themes[themeId] ?? themes[DEFAULT_THEME_ID]

  const setThemeId = (id: string): void => {
    if (!themes[id]) return
    setThemeIdState(id)
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      /* ignore */
    }
  }

  // useLayoutEffect : applique avant le premier paint pour éviter tout flash.
  useLayoutEffect(() => {
    applyTheme(theme)
  }, [theme])

  return (
    <ThemeContext.Provider value={{ theme, setThemeId, available: Object.values(themes) }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme doit être utilisé dans <ThemeProvider>')
  return ctx
}
