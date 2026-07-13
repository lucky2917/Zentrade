import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png", "pwa-192x192.png", "pwa-512x512.png"],
      manifest: {
        name: "Zentrade",
        short_name: "Zentrade",
        description: "Paper trading simulator with real-time NSE market data",
        theme_color: "#080808",
        background_color: "#080808",
        display: "standalone",
        orientation: "portrait-primary",
        scope: "/",
        start_url: "/",
        icons: [
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        // Never serve index.html for backend routes — /fyers/callback is an
        // OAuth redirect target and must reach the server, not the SPA shell
        navigateFallbackDenylist: [/^\/api\//, /^\/fyers\//, /^\/socket\.io\//],
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        runtimeCaching: [
          {
            // urlPattern regexes run against the full URL, so match on pathname
            urlPattern: ({ url }) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/fyers/"),
            handler: "NetworkOnly",
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/socket.io/"),
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      // overridable so docker-compose can point at the api container
      "/api": process.env.VITE_PROXY_TARGET || "http://localhost:5001",
      "/fyers": process.env.VITE_PROXY_TARGET || "http://localhost:5001",
      "/socket.io": {
        target: process.env.VITE_PROXY_TARGET || "http://localhost:5001",
        ws: true,
      },
    },
    allowedHosts: [
      "nonperversive-nondeafly-dorla.ngrok-free.dev",
    ],
  },
});
