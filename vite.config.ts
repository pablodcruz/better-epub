import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => ({
  base: mode === "production" ? "./" : "/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "service-worker.ts",
      manifest: {
        name: "Better ePub",
        short_name: "Better ePub",
        description: "A private, local-first EPUB reader.",
        theme_color: "#f4f0e8",
        background_color: "#f4f0e8",
        display: "standalone",
        start_url: "./",
        scope: "./",
        categories: ["books", "education", "productivity"],
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }
        ],
        file_handlers: [
          {
            action: "./?import=epub",
            accept: { "application/epub+zip": [".epub"] }
          }
        ]
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"]
      },
      devOptions: {
        enabled: true,
        type: "module"
      }
    })
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"]
  }
}));
