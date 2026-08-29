import { defineConfig } from 'tsdown'

// The client half is bundled into a single lib/client.js — the DSH web shell
// fetches it at /plugins/dsh-codex-continue/client.js (hashed into the boot
// graph by @deepseek-ai/dsh-client-modules). React / ReactDOM / Cordis and
// every @deepseek-ai client package are provided by the shell at runtime, so
// they stay unbundled.
export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  deps: {
    neverBundle: ['react', 'react-dom', 'react-dom/client', 'cordis', /^@deepseek-ai\//],
  },
  sourcemap: true,
  clean: false,
})
