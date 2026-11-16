import type { Config } from 'tailwindcss';
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#eff6ff', 100: '#dbeafe', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 900: '#1e3a8a' },
      },
      fontFamily: { sans: ['"Noto Sans"', '"Noto Sans Devanagari"', '"Noto Sans Telugu"', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
} satisfies Config;
