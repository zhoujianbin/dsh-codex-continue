import { defineConfig } from 'tsdown'

// The client half is bundled into a single lib/client.js — the DSH web shell
// fetches it at /plugins/dsh-codex-continue/client.js (hashed into the boot
// graph by @deepseek-ai/dsh-client-modules). React / ReactDOM / Cordis and
// every @deepseek-ai client package are provided by the shell at runtime, so
// they stay unbundled.
export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'node',
  target: 'es2022',
  outExtensions: () => ({ js: '.js' }),
  banner: `window.__ModuleLoader__.load({
  id: "dsh-codex-continue",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;`,
  footer: `    return module.exports;
  }
});`,
  deps: {
    neverBundle: ['react', 'react-dom', 'react-dom/client', 'cordis', /^@deepseek-ai\//],
  },
  sourcemap: true,
  clean: false,
})
