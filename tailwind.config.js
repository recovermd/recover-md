/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: 'rgb(var(--rmd-surface) / <alpha-value>)',
        panel: 'rgb(var(--rmd-panel) / <alpha-value>)',
        edge: 'rgb(var(--rmd-edge) / <alpha-value>)',
        ink: 'rgb(var(--rmd-ink) / <alpha-value>)',
        muted: 'rgb(var(--rmd-muted) / <alpha-value>)',
        accent: 'rgb(var(--rmd-accent) / <alpha-value>)'
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
      }
    }
  },
  plugins: []
};
