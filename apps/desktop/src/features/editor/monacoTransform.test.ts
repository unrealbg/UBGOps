import { describe, expect, it } from 'vitest';
import {
  EXPECTED_MONACO_VERSION,
  MONACO_PROTOTYPE_PATCHES,
  applyPinnedMonacoPrototypePatch,
  verifyInstalledMonacoVersion,
} from '../../build/monacoFrozenPrototype';

describe('pinned Monaco frozen-prototype build transform', () => {
  it('verifies the exact pinned monaco-editor version', () => {
    expect(verifyInstalledMonacoVersion()).toBe(EXPECTED_MONACO_VERSION);
  });

  it('transforms only the five pinned assignments and fails closed on drift', () => {
    expect(MONACO_PROTOTYPE_PATCHES).toHaveLength(5);
    for (const patch of MONACO_PROTOTYPE_PATCHES) {
      const id = `D:\\repo\\node_modules${patch.suffix.replaceAll('/', '\\')}`;
      const transformed = applyPinnedMonacoPrototypePatch(`before\n${patch.target}\nafter`, id);
      expect(transformed).toBe(`before\n${patch.replacement}\nafter`);

      // Fails closed if expected target is missing or duplicated.
      expect(() => applyPinnedMonacoPrototypePatch('unrelated content', id)).toThrow(/Expected one/);
      expect(() =>
        applyPinnedMonacoPrototypePatch(`${patch.target}\n${patch.target}`, id),
      ).toThrow(/Expected one/);
    }
    expect(applyPinnedMonacoPrototypePatch('anything', '/node_modules/monaco-editor/esm/vs/other.js')).toBeUndefined();
  });
});
