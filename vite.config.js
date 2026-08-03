import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Single-page setup:
//   /   → SMR Dashboard (index.html → src/cashflow/main.tsx)
// The dashboard's /api calls are proxied to the Striven backend (striven-server)
// at dev time. Override the target with VITE_SMR_API if the backend runs elsewhere.
const SMR_API = process.env.VITE_SMR_API || "http://localhost:4747";

// ── Audience split ───────────────────────────────────────────────────────────
// SMR_AUDIENCE=rep swaps the currency module for a stub that throws, so the rep
// bundle contains no Intl currency formatter, no 'USD', and no dollar strings.
//
// This is the enforcement point for the rep-visibility rule. It is a DATA rule,
// not a styling one — hiding money elements with CSS on a shared codebase still
// ships the money to the browser, where anyone can read it in devtools. Keep
// the exclusion here.
//
// Components must import money as the bare specifier `@money` (never a relative
// path), or this alias will not catch them. `npm run verify:rep` proves the
// result against the built output rather than trusting this config.
const AUDIENCE = process.env.SMR_AUDIENCE === "rep" ? "rep" : "exec";
const MONEY_IMPL = AUDIENCE === "rep"
  ? resolve(__dirname, "src/design/money.rep.ts")
  : resolve(__dirname, "src/design/money.ts");

export default defineConfig({
  plugins: [react()],
  define: {
    __SMR_AUDIENCE__: JSON.stringify(AUDIENCE),
  },
  resolve: {
    alias: [{ find: /^@money$/, replacement: MONEY_IMPL }],
  },
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
    // Separate output roots so the two audiences can never overwrite each
    // other, and so verify:rep always inspects a rep-only tree.
    outDir: AUDIENCE === "rep" ? "dist-rep" : "dist",
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
