/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        trace: {
          bg: '#0a0a0b',
          fg: '#f4f4f5',
          accent: '#ffd84a',
          muted: '#9ca3af',
          line: '#27272a',
        },
        // Game-mode "Most Wanted 2005" cold-blue palette. Near-black with a
        // steel-blue tint and an electric-blue accent — the gritty MW menu look.
        mw: {
          bg: '#05080d',
          panel: '#0b1320',
          steel: '#16212f',
          edge: '#243446',
          text: '#e6eef7',
          muted: '#7d91a8',
          accent: '#36a6ff',
          accent2: '#0a6fd0',
          hot: '#ff5a2c',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        // Condensed display face for game-mode headings (NFS-style big caps).
        display: ['Oswald', 'Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
