import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const daemon = `http://127.0.0.1:${process.env.HORTUS_CONSOLE_PORT ?? 7700}`;

// No React plugin: Vite's own transform reads tsconfig's `jsx: react-jsx` (no Fast Refresh, a full reload on edit).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "../dist/web", emptyOutDir: true },
  // `pnpm web`: the daemon's console (HORTUS_CONSOLE_PORT, as hortusd reads it); changeOrigin: its Host check wants its
  // own address
  server: {
    proxy: {
      "/api": { target: daemon, changeOrigin: true },
      "/events": { target: daemon, changeOrigin: true },
    },
  },
});
