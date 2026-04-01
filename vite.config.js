import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:5001",
      "/socket.io": {
        target: "http://localhost:5001",
        ws: true,
      },
    },
    allowedHosts: [
      'nonperversive-nondeafly-dorla.ngrok-free.dev'
    ]
  },
});

/*
 * vite config for the react frontend. the proxy section is important —
 * it forwards /api and /socket.io requests to the backend on port 5001
 * so you dont run into cors issues during local dev.
 */
