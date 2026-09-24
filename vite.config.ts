import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  // Serve the fetched JSON as static files: data/AAPL.json → /AAPL.json
  publicDir: "../data",
  plugins: [react()],
  build: { outDir: "../dist-web", emptyOutDir: true },
});
