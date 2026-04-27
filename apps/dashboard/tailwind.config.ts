import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#F5F1EB',
        foreground: '#1F1F1F',
        muted: '#5C5C5C',
        border: '#E0DCD4',
        card: '#FFFFFF',
        primary: {
          DEFAULT: '#7C3AED',
          foreground: '#FFFFFF',
        },
        black: '#0A0A0A',
        badgeBg: '#EFE9FA',
        destructive: {
          DEFAULT: '#FCEBEB',
          text: '#B91C1C',
        },
      },
      fontFamily: {
        serif: ['var(--font-newsreader)', 'serif'],
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '0.5rem',
      },
    },
  },
  plugins: [],
};

export default config;
