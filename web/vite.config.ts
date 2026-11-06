import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// No React plugin: Vite's own transform reads tsconfig's `jsx: react-jsx` (no Fast Refresh, a full reload on edit).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
