import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { optimizeDeps, resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_MONACO_VERSION,
  MONACO_PROTOTYPE_PATCHES,
  applyPinnedMonacoPrototypePatch,
  resolvePinnedMonacoFile,
  verifyInstalledMonacoVersion,
} from '../../build/monacoFrozenPrototype';

const DESKTOP_VITE_CONFIG = existsSync(resolve('vite.config.ts'))
  ? resolve('vite.config.ts')
  : resolve('apps/desktop/vite.config.ts');

describe('pinned Monaco frozen-prototype build transform', () => {
  it('verifies the exact pinned monaco-editor version and resolves pinned codicon CSS assets fail-closed', () => {
    expect(verifyInstalledMonacoVersion()).toBe(EXPECTED_MONACO_VERSION);
    expect(existsSync(resolvePinnedMonacoFile('esm/vs/base/browser/ui/codicons/codicon/codicon.css'))).toBe(true);
    expect(
      existsSync(resolvePinnedMonacoFile('esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css')),
    ).toBe(true);
    expect(() => resolvePinnedMonacoFile('esm/vs/does/not/exist.css')).toThrow(/Pinned monaco-editor asset/);
  });

  it('transforms only the five pinned assignments (including Vite query-suffixed ids) and fails closed on drift', () => {
    expect(MONACO_PROTOTYPE_PATCHES).toHaveLength(5);
    for (const patch of MONACO_PROTOTYPE_PATCHES) {
      const id = `D:\\repo\\node_modules${patch.suffix.replaceAll('/', '\\')}`;
      const transformed = applyPinnedMonacoPrototypePatch(`before\n${patch.target}\nafter`, id);
      expect(transformed).toBe(`before\n${patch.replacement}\nafter`);

      expect(
        applyPinnedMonacoPrototypePatch(`before\n${patch.target}\nafter`, `${id}?v=1234&worker_file`),
      ).toBe(`before\n${patch.replacement}\nafter`);

      // Fails closed if expected target is missing or duplicated.
      expect(() => applyPinnedMonacoPrototypePatch('unrelated content', id)).toThrow(/Expected one/);
      expect(() =>
        applyPinnedMonacoPrototypePatch(`${patch.target}\n${patch.target}`, id),
      ).toThrow(/Expected one/);
    }
    expect(applyPinnedMonacoPrototypePatch('anything', '/node_modules/monaco-editor/esm/vs/other.js')).toBeUndefined();
  });

  it('applies all frozen-prototype transforms in Vite dev optimizeDeps across cold and warm caches', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'ubgops-vite-dev-monaco-'));
    const rawTargets = [
      'KeyCodeUtils.toString = toString;',
      'Severity.toString = toString;',
      'MarkerSeverity.toString = toString;',
      'InlineSuggestAlternativeAction.toString = toString;',
      'result[e] = true;',
    ];

    async function verifyPrebundledDeps(force: boolean) {
      const resolved = await resolveConfig(
        {
          configFile: DESKTOP_VITE_CONFIG,
          cacheDir,
          logLevel: 'silent',
        },
        'serve',
      );
      await optimizeDeps(resolved, force, true);
      const depsDir = join(cacheDir, 'deps');
      const depFiles = readdirSync(depsDir).filter((file) => file.endsWith('.js'));
      const monacoBundles = depFiles.filter((file) => file.includes('monaco-editor'));
      expect(monacoBundles.length).toBeGreaterThan(0);

      const xtermBundle = depFiles.find((file) => file.includes('@xterm_xterm'));
      expect(xtermBundle).toBeTruthy();

      let patchedHits = 0;
      let xtermPatched = false;
      for (const file of depFiles) {
        const body = readFileSync(join(depsDir, file), 'utf8');
        for (const raw of rawTargets) {
          expect(body.includes(raw), `Unpatched target "${raw}" found in ${file}`).toBe(false);
        }
        if (file === xtermBundle) {
          expect(body.includes('o.toString = s;')).toBe(false);
          expect(body.includes('o.toString=s;')).toBe(false);
          if (
            body.includes('Object.defineProperty(o, "toString"') ||
            body.includes('Object.defineProperty(o,"toString"')
          ) {
            xtermPatched = true;
          }
        }
        if (
          body.includes('Object.defineProperty(KeyCodeUtils') ||
          body.includes('Object.defineProperty(Severity') ||
          body.includes('Object.defineProperty(MarkerSeverity') ||
          body.includes('Object.defineProperty(result, e')
        ) {
          patchedHits += 1;
        }
      }
      expect(patchedHits).toBeGreaterThan(0);
      expect(xtermPatched).toBe(true);
    }

    try {
      await verifyPrebundledDeps(true);
      await verifyPrebundledDeps(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 30_000);
});
