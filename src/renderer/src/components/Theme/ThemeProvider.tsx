import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react'
import { applyTheme, themes, DEFAULT_THEME_ID, type Theme } from './themes'

interface ThemeContextValue {
  theme: Theme
  setThemeId: (id: string) => void
  available: Theme[]
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState<string>(DEFAULT_THEME_ID)
  const theme = themes[themeId] ?? themes[DEFAULT_THEME_ID]

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
