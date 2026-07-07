import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        base: {
          950: "#05070a",
          900: "#0b0e14",
          850: "#10141d",
          800: "#141924",
          700: "#1c2230",
          600: "#28303f",
          500: "#3a4356",
        },
        ink: {
          100: "#f4f6f8",
          300: "#c4cbd6",
          400: "#98a2b3",
          500: "#717d8f",
          600: "#4d5666",
        },
        accent: {
          teal: "#3ecf9e",
          blue: "#5b8def",
          amber: "#e8a33d",
          red: "#e2584f",
        },
      },
      fontFamily: {
        sans: [
          "var(--font-inter)",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        panel: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.5)",
      },
      borderRadius: {
        xl2: "1rem",
      },
    },
  },
  plugins: [],
};

export default config;
