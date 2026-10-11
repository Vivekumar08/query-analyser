// Tailwind 4 is configured in CSS (`@import "tailwindcss"`), not in a JS
// config file. There is deliberately no tailwind.config.js.
export default {
  plugins: { '@tailwindcss/postcss': {} },
};
