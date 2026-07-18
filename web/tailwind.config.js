/** Tailwind mapeado para os tokens do Design System (CSS variables).
 *  Assim o mesmo componente funciona em dark e light apenas trocando as vars. */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-raised': 'var(--surface-raised)',
        'surface-glass': 'var(--surface-glass)',
        border: 'var(--border)',
        text: 'var(--text)',
        muted: 'var(--text-muted)',
        subtle: 'var(--text-subtle)',
        primary: { DEFAULT: 'var(--primary)', hover: 'var(--primary-hover)', fg: 'var(--primary-fg)', soft: 'var(--primary-soft)' },
        success: { DEFAULT: 'var(--success)', soft: 'var(--success-soft)' },
        danger: { DEFAULT: 'var(--danger)', soft: 'var(--danger-soft)' },
        warning: { DEFAULT: 'var(--warning)', soft: 'var(--warning-soft)' },
        info: { DEFAULT: 'var(--info)', soft: 'var(--info-soft)' },
        early: { DEFAULT: 'var(--early)', soft: 'var(--early-soft)' },
      },
      borderRadius: { sm: '8px', md: '12px', lg: '16px', xl: '22px' },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'monospace'] },
      boxShadow: {
        sm: 'var(--shadow-card)',
        md: '0 16px 38px rgba(0,0,0,.16)',
        lg: 'var(--shadow-float)',
      },
    },
  },
  plugins: [],
}
