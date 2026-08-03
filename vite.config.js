import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Single-page setup:
//   /   → SMR Dashboard (index.html → src/cashflow/main.tsx)
// The dashboard's /api calls are proxied to the Striven backend (striven-server)
// at dev time. Override the target with VITE_SMR_API if the backend runs elsewhere.
const SMR_API = process.env.VITE_SMR_API || "http://localhost:4747";

// There is ONE bundle. There used to be two — SMR_AUDIENCE=rep aliased `@money`
// to a throwing stub so the rep build could not render currency — but the rep
// portal shows dollars on nearly every screen, so that build had already ceased
// to work. Rep visibility is now enforced by ROLE at runtime: the server denies
// company routes to non-admins and redacts other reps' figures before it
// serializes. See src/cashflow/format.ts for the full note.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // Allow public tunnel hosts (cloudflared / localtunnel / ngrok) for previews.
    allowedHosts: [".trycloudflare.com", ".loca.lt", ".ngrok-free.app", ".ngrok.io"],
    proxy: {
      "/api": { target: SMR_API, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          recharts: ["recharts"],
        },
      },
    },
  },
});
