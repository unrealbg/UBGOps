import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';

export const EXPECTED_MONACO_VERSION = '0.58.0';

export interface MonacoPrototypePatch {
  readonly suffix: string;
  readonly target: string;
  readonly replacement: string;
}

export const MONACO_PROTOTYPE_PATCHES: readonly MonacoPrototypePatch[] = [
  {
    suffix: '/monaco-editor/esm/vs/base/common/keyCodes.js',
    target: 'KeyCodeUtils.toString = toString;',
    replacement:
      'Object.defineProperty(KeyCodeUtils, "toString", { value: toString, writable: true, configurable: true });',
  },
  {
    suffix: '/monaco-editor/esm/vs/base/common/severity.js',
    target: 'Severity.toString = toString;',
    replacement:
      'Object.defineProperty(Severity, "toString", { value: toString, writable: true, configurable: true });',
  },
  {
    suffix: '/monaco-editor/esm/vs/platform/markers/common/markers.js',
    target: 'MarkerSeverity.toString = toString;',
    replacement:
      'Object.defineProperty(MarkerSeverity, "toString", { value: toString, writable: true, configurable: true });',
  },
  {
    suffix:
      '/monaco-editor/esm/vs/editor/contrib/inlineCompletions/browser/model/InlineSuggestAlternativeAction.js',
    target: 'InlineSuggestAlternativeAction.toString = toString;',
    replacement:
      'Object.defineProperty(InlineSuggestAlternativeAction, "toString", { value: toString, writable: true, configurable: true });',
  },
];

export function verifyInstalledMonacoVersion(
  resolveFromUrl: string = import.meta.url,
): string {
  const require = createRequire(resolveFromUrl);
  let entryPath: string;
  try {
    entryPath = require.resolve('monaco-editor');
  } catch {
    throw new Error('Pinned monaco-editor dependency is missing.');
  }
  let dir = dirname(entryPath);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === 'monaco-editor') {
        if (parsed.version !== EXPECTED_MONACO_VERSION) {
          throw new Error(
            `Expected monaco-editor@${EXPECTED_MONACO_VERSION}, found ${String(parsed.version)}.`,
          );
        }
        return EXPECTED_MONACO_VERSION;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Pinned monaco-editor package metadata is missing near ${entryPath}.`);
}

export function applyPinnedMonacoPrototypePatch(source: string, id: string): string | undefined {
  const normalized = id.replaceAll('\\', '/');
  const patch = MONACO_PROTOTYPE_PATCHES.find((entry) => normalized.endsWith(entry.suffix));
  if (!patch) return undefined;
  const occurrences = source.split(patch.target).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Expected one pinned Monaco toString assignment in ${patch.suffix}, found ${occurrences}.`,
    );
  }
  // Tauri freezes Object.prototype. Define own namespace toString without
  // assigning through the inherited non-writable prototype property.
  return source.replace(patch.target, patch.replacement);
}

export function monacoFrozenPrototypeCompatibility(): Plugin {
  let resolveFromUrl = import.meta.url;
  let versionVerified = false;
  return {
    name: 'monaco-frozen-prototype-compatibility',
    enforce: 'pre',
    configResolved(config) {
      resolveFromUrl = pathToFileURL(join(config.root, 'package.json')).href;
    },
    buildStart() {
      verifyInstalledMonacoVersion(resolveFromUrl);
      versionVerified = true;
    },
    transform(source: string, id: string) {
      const normalized = id.replaceAll('\\', '/');
      if (!normalized.includes('/monaco-editor/')) return undefined;
      if (!versionVerified) {
        verifyInstalledMonacoVersion(resolveFromUrl);
        versionVerified = true;
      }
      return applyPinnedMonacoPrototypePatch(source, normalized);
    },
  };
}
