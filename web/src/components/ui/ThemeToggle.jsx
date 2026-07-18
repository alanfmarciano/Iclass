import { Sun, Moon } from 'lucide-react'
import { useTheme } from '../../context/ThemeProvider'
export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return (
    <button onClick={toggle} aria-label={`Mudar para tema ${theme === 'dark' ? 'claro' : 'escuro'}`}
      className="w-9 h-9 grid place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text transition">
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}
