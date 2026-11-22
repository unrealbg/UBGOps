import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import test from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const FORBIDDEN_FILES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
]);

const SKIP_EXTENSIONS = new Set(['.png', '.ico', '.exe', '.pdb', '.woff', '.woff2']);
const SKIP_PATHS = new Set([
  'Cargo.lock',
  'package-lock.json',
  'tools/policy/repo-hygiene.test.mjs',
]);

const FORBIDDEN_PATTERNS = [
  { label: 'personal Windows user path', regex: /C:\\Users\\(?!owner\\)/i },
  { label: 'personal Unix user path', regex: /\/(?:Users|home)\/jack\b/i },
  { label: 'sandbox group leak', regex: /\bCodexSandboxUsers\b/ },
  { label: 'internal review verdict banner', regex: /READY FOR SOURCE REVIEW/ },
  { label: 'GitHub PAT prefix', regex: /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{10,}\b/ },
  { label: 'AWS access key prefix', regex: /\bAKIA[0-9A-Z]{16}\b/ },
];

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

test('repository contains no agent instruction files', () => {
  const files = trackedFiles();
  for (const file of files) {
    assert.equal(
      FORBIDDEN_FILES.has(file),
      false,
      `Forbidden agent instruction file tracked: ${file}`,
    );
  }
});

test('repository contains no personal paths, internal review markers, or token prefixes', () => {
  const files = trackedFiles();
  for (const file of files) {
    if (SKIP_PATHS.has(file) || SKIP_EXTENSIONS.has(extname(file).toLowerCase())) {
      continue;
    }
    const content = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    for (const { label, regex } of FORBIDDEN_PATTERNS) {
      assert.equal(
        regex.test(content),
        false,
        `Forbidden ${label} found in tracked file: ${file}`,
      );
    }
  }
});
