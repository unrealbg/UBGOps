import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_ASSET_PATTERNS = [
  { key: 'monacoSurfaceJs', regex: /^\/assets\/MonacoViewerSurface-[^/]+\.js$/ },
  { key: 'monacoSurfaceCss', regex: /^\/assets\/MonacoViewerSurface-[^/]+\.css$/ },
  { key: 'codiconTtf', regex: /^\/assets\/codicon-[^/]+\.ttf$/ },
  { key: 'editorWorkerJs', regex: /^\/assets\/editor\.worker-[^/]+\.js$/ },
  { key: 'jsonWorkerJs', regex: /^\/assets\/json\.worker-[^/]+\.js$/ },
  { key: 'jsonModeJs', regex: /^\/assets\/jsonMode-[^/]+\.js$/ },
  { key: 'jsonModeCss', regex: /^\/assets\/jsonMode-[^/]+\.css$/ },
];

function collectDistFiles(distDir) {
  const results = [];
  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const rel = '/' + relative(distDir, fullPath).split(sep).join('/');
        results.push(rel);
      }
    }
  }
  walk(distDir);
  return results;
}

function findDesktopBuildOutput(buildDir) {
  if (!existsSync(buildDir)) {
    throw new Error(`Cargo release build directory does not exist: ${buildDir}`);
  }
  const candidates = [];
  for (const entry of readdirSync(buildDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('ubgops-desktop-')) continue;
    const outputFile = resolve(buildDir, entry.name, 'output');
    if (existsSync(outputFile)) {
      candidates.push({ outputFile, mtimeMs: statSync(outputFile).mtimeMs });
    }
  }
  if (candidates.length === 0) {
    throw new Error(`No ubgops-desktop-*/output build metadata found in ${buildDir}`);
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

export function verifyProductionArtifact({ distDir, buildDir, binaryPath }) {
  if (!existsSync(distDir)) {
    throw new Error(`Production frontend dist directory missing: ${distDir}`);
  }
  const indexHtmlPath = resolve(distDir, 'index.html');
  if (!existsSync(indexHtmlPath)) {
    throw new Error(`Missing index.html in production dist directory: ${indexHtmlPath}`);
  }
  const indexHtml = readFileSync(indexHtmlPath, 'utf8');
  if (/http:\/\/localhost:1420/i.test(indexHtml)) {
    throw new Error('Production dist/index.html still references dev server http://localhost:1420');
  }

  const distInventory = collectDistFiles(distDir);
  if (distInventory.length === 0) {
    throw new Error(`Production dist directory is empty: ${distDir}`);
  }

  const requiredAssetMatches = {};
  for (const req of REQUIRED_ASSET_PATTERNS) {
    const matched = distInventory.filter((assetPath) => req.regex.test(assetPath));
    if (matched.length === 0) {
      throw new Error(`Missing required production asset family (${req.key}) in ${distDir}`);
    }
    requiredAssetMatches[req.key] = matched;
  }

  const buildOutputs = findDesktopBuildOutput(buildDir);
  const cfgDevOutputs = [];
  for (const { outputFile } of buildOutputs) {
    const content = readFileSync(outputFile, 'utf8');
    if (/^cargo:rustc-cfg=dev$/m.test(content)) {
      cfgDevOutputs.push(outputFile);
    }
  }
  if (cfgDevOutputs.length > 0) {
    throw new Error(
      `Desktop crate build output contains cargo:rustc-cfg=dev (not a custom-protocol production build): ${cfgDevOutputs.join(', ')}`,
    );
  }

  if (!existsSync(binaryPath)) {
    throw new Error(`Production binary missing: ${binaryPath}`);
  }
  const binaryBuffer = readFileSync(binaryPath);
  const missingAssets = [];
  for (const assetPath of distInventory) {
    const needle = Buffer.from(assetPath, 'utf8');
    if (!binaryBuffer.includes(needle)) {
      missingAssets.push(assetPath);
    }
  }
  if (missingAssets.length > 0) {
    throw new Error(
      `Production binary ${binaryPath} is missing ${missingAssets.length} embedded dist asset(s): ${missingAssets.slice(0, 10).join(', ')}`,
    );
  }

  const binarySha256 = createHash('sha256').update(binaryBuffer).digest('hex').toUpperCase();
  return {
    distDir,
    buildDir,
    binaryPath,
    binaryBytes: binaryBuffer.length,
    binarySha256,
    distAssetCount: distInventory.length,
    verifiedEmbeddedCount: distInventory.length - missingAssets.length,
    missingAssets,
    hasCfgDev: false,
    inspectedBuildOutputs: buildOutputs.map((entry) => entry.outputFile),
    requiredAssetMatches,
    distInventory,
  };
}

function parseArgs(argv) {
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const targetDir = process.env.CARGO_TARGET_DIR
    ? resolve(process.env.CARGO_TARGET_DIR)
    : resolve(repoRoot, 'target');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const options = {
    distDir: resolve(repoRoot, 'apps', 'desktop', 'dist'),
    buildDir: resolve(targetDir, 'release', 'build'),
    binaryPath: resolve(targetDir, 'release', `ubgops-desktop${ext}`),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dist' && argv[i + 1]) {
      options.distDir = resolve(argv[++i]);
    } else if (arg === '--build-dir' && argv[i + 1]) {
      options.buildDir = resolve(argv[++i]);
    } else if (arg === '--binary' && argv[i + 1]) {
      options.binaryPath = resolve(argv[++i]);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = verifyProductionArtifact(opts);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Production artifact verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
