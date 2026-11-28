import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyProductionArtifact } from './verify-production-artifact.mjs';

const REQUIRED_ASSETS = [
  'assets/MonacoViewerSurface-abc123.js',
  'assets/MonacoViewerSurface-abc123.css',
  'assets/codicon-abc123.ttf',
  'assets/editor.worker-abc123.js',
  'assets/json.worker-abc123.js',
  'assets/jsonMode-abc123.js',
  'assets/jsonMode-abc123.css',
];

function createSyntheticArtifact({
  omitAsset = null,
  cfgDev = false,
  devUrlInHtml = false,
  omitEmbeddedPath = null,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ubgops-artifact-test-'));
  const distDir = join(root, 'dist');
  const buildDir = join(root, 'release', 'build');
  const pkgBuildDir = join(buildDir, 'ubgops-desktop-0123456789abcdef');
  const binaryPath = join(root, 'ubgops-desktop.bin');

  mkdirSync(join(distDir, 'assets'), { recursive: true });
  mkdirSync(pkgBuildDir, { recursive: true });

  writeFileSync(
    join(distDir, 'index.html'),
    devUrlInHtml
      ? '<html><script src="http://localhost:1420/src/main.tsx"></script></html>'
      : '<html><script src="/assets/index.js"></script></html>',
  );
  writeFileSync(join(distDir, 'assets', 'index.js'), 'console.log("ubgops");');
  for (const rel of REQUIRED_ASSETS) {
    if (rel === omitAsset) continue;
    writeFileSync(join(distDir, rel), `content:${rel}`);
  }

  writeFileSync(
    join(pkgBuildDir, 'output'),
    cfgDev ? 'cargo:rustc-cfg=dev\n' : 'cargo:rerun-if-changed=../dist\n',
  );

  const allPaths = ['/index.html', '/assets/index.js', ...REQUIRED_ASSETS.map((p) => '/' + p)]
    .filter((p) => ('/' + omitAsset) !== p && p !== omitEmbeddedPath);
  writeFileSync(binaryPath, Buffer.from(allPaths.join('\0'), 'utf8'));

  return { root, distDir, buildDir, binaryPath };
}

test('verifyProductionArtifact passes when complete dist inventory is embedded without cfg(dev)', () => {
  const fx = createSyntheticArtifact();
  try {
    const result = verifyProductionArtifact(fx);
    assert.equal(result.hasCfgDev, false);
    assert.equal(result.missingAssets.length, 0);
    assert.equal(result.verifiedEmbeddedCount, result.distAssetCount);
    assert.ok(result.binarySha256.length === 64);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('verifyProductionArtifact rejects build output containing cargo:rustc-cfg=dev', () => {
  const fx = createSyntheticArtifact({ cfgDev: true });
  try {
    assert.throws(() => verifyProductionArtifact(fx), /cargo:rustc-cfg=dev/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('verifyProductionArtifact rejects missing required Monaco/Codicon/Worker asset family', () => {
  const fx = createSyntheticArtifact({ omitAsset: 'assets/codicon-abc123.ttf' });
  try {
    assert.throws(() => verifyProductionArtifact(fx), /codiconTtf/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('verifyProductionArtifact rejects binary missing a dist inventory file', () => {
  const fx = createSyntheticArtifact({ omitEmbeddedPath: '/assets/json.worker-abc123.js' });
  try {
    assert.throws(() => verifyProductionArtifact(fx), /missing 1 embedded dist asset/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('verifyProductionArtifact rejects dev server URL in dist index.html', () => {
  const fx = createSyntheticArtifact({ devUrlInHtml: true });
  try {
    assert.throws(() => verifyProductionArtifact(fx), /localhost:1420/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
