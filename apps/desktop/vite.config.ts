import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import {
  monacoFrozenPrototypeCompatibility,
  monacoFrozenPrototypeRolldownPlugin,
  resolvePinnedMonacoFile,
} from './src/build/monacoFrozenPrototype.ts';

function applyPinnedXtermPrototypePatch(source: string, id: string): string | undefined {
  const xtermSuffix = '/@xterm/xterm/lib/xterm.mjs';
  const inheritedAssignment = 'o.toString=s;function t(';
  const ownProperty = 'Object.defineProperty(o,"toString",{value:s,writable:!0,configurable:!0});function t(';
  const normalized = id.split('?', 1)[0]!.replaceAll('\\', '/');
  if (!normalized.endsWith(xtermSuffix)) return;
  const occurrences = source.split(inheritedAssignment).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected one pinned xterm toString assignment, found ${occurrences}.`);
  }
  // Tauri freezes Object.prototype. Define the namespace's own property without
  // assigning through the inherited, non-writable prototype descriptor.
  return source.replace(inheritedAssignment, ownProperty);
}

function xtermFrozenPrototypeCompatibility() {
  return {
    name: 'xterm-frozen-prototype-compatibility',
    enforce: 'pre' as const,
    transform(source: string, id: string) {
      return applyPinnedXtermPrototypePatch(source, id);
    },
  };
}

function xtermFrozenPrototypeRolldownPlugin() {
  return {
    name: 'xterm-frozen-prototype-rolldown',
    transform(source: string, id: string) {
      return applyPinnedXtermPrototypePatch(source, id);
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@ubgops/monaco-codicon.css': resolvePinnedMonacoFile(
        'esm/vs/base/browser/ui/codicons/codicon/codicon.css',
        new URL('./package.json', import.meta.url).href,
      ),
      '@ubgops/monaco-codicon-modifiers.css': resolvePinnedMonacoFile(
        'esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css',
        new URL('./package.json', import.meta.url).href,
      ),
    },
  },
  plugins: [xtermFrozenPrototypeCompatibility(), monacoFrozenPrototypeCompatibility(), react()],
  worker: {
    format: 'es',
    plugins: () => [monacoFrozenPrototypeCompatibility()],
  },
  optimizeDeps: {
    rolldownOptions: {
      plugins: [
        xtermFrozenPrototypeRolldownPlugin(),
        monacoFrozenPrototypeRolldownPlugin(new URL('./package.json', import.meta.url).href),
      ],
    },
  },
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
