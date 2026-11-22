import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import test from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const FORBIDDEN_BASENAMES = new Set([
  'agents.md',
  'claude.md',
  '.cursorrules',
  'copilot-instructions.md',
  '.windsurfrules',
  '.clinerules',
  '.aider.conf.yml',
]);

const FORBIDDEN_PATH_SEGMENTS = new Set(['.cursor', '.codex', '.claude', '.windsurf', '.agent']);

const SKIP_PATHS = new Set([
  'Cargo.lock',
  'package-lock.json',
  'tools/policy/repo-hygiene.test.mjs',
]);

const FORBIDDEN_PATTERNS = [
  {
    label: 'personal Windows user path',
    regex: /\b[A-Za-z]:\\+Users\\+(?!owner\b|<[^>]+>)[A-Za-z0-9._-]+(?:\\+|\b)/i,
  },
  {
    label: 'personal Unix user path',
    regex: /(?:^|[\s"'`(])\/(?:Users|home)\/(?!test\b|other\b|\$[A-Za-z_]|<[^>]+>)[A-Za-z0-9._-]+(?:\/|\b)/,
  },
  {
    label: 'sandbox group leak',
    regex: /\bCodexSandboxUsers\b/,
  },
  {
    label: 'internal review verdict banner',
    regex: /READY FOR SOURCE REVIEW/,
  },
  {
    label: 'GitHub token prefix',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}\b/,
  },
  {
    label: 'AWS access key prefix',
    regex: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    label: 'private key header',
    regex: /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP|ENCRYPTED )?PRIVATE KEY-----/,
    allowIn: new Set(['apps/desktop/src/features/hosts/HostForm.tsx', 'docs/validation/goal-01a-report.md']),
  },
];

function isLikelyBinary(buffer) {
  return buffer.includes(0);
}

function findForbiddenFile(repoRelativePath) {
  const normalized = repoRelativePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const basename = posix.basename(normalized).toLowerCase();

  if (FORBIDDEN_BASENAMES.has(basename)) {
    return `forbidden agent instruction file (${basename})`;
  }
  for (const segment of segments.slice(0, -1)) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase())) {
      return `forbidden agent configuration directory (${segment})`;
    }
  }
  return null;
}

function scanTextContent(repoRelativePath, text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.allowIn?.has(repoRelativePath)) {
        continue;
      }
      if (rule.regex.test(line)) {
        findings.push({ file: repoRelativePath, line: index + 1, label: rule.label });
      }
    }
  }
  return findings;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

test('repository contains no agent instruction files or agent config directories at any depth', () => {
  for (const file of trackedFiles()) {
    const violation = findForbiddenFile(file);
    assert.equal(violation, null, `Disallowed tracked path ${file}: ${violation}`);
  }
});

test('repository tracked text files contain no personal paths, internal markers, or credential patterns', () => {
  for (const file of trackedFiles()) {
    if (SKIP_PATHS.has(file)) {
      continue;
    }
    const raw = readFileSync(resolve(REPO_ROOT, file));
    if (isLikelyBinary(raw)) {
      continue;
    }
    const text = raw.toString('utf8');
    const findings = scanTextContent(file, text);
    assert.equal(
      findings.length,
      0,
      findings.map((f) => `Forbidden ${f.label} in ${f.file} at line ${f.line}`).join('; '),
    );
  }
});

test('policy detects nested forbidden agent files and config directories', () => {
  assert.ok(findForbiddenFile('AGENTS.md'));
  assert.ok(findForbiddenFile('crates/ubgops-core/AGENTS.md'));
  assert.ok(findForbiddenFile('docs/nested/CLAUDE.md'));
  assert.ok(findForbiddenFile('.github/copilot-instructions.md'));
  assert.ok(findForbiddenFile('apps/desktop/.cursor/rules/local.mdc'));
  assert.ok(findForbiddenFile('tools/.codex/config.toml'));
  assert.equal(findForbiddenFile('docs/development/setup.md'), null);
});

test('policy detects arbitrary personal Windows and Unix paths without exposing matched values', () => {
  const winFindings = scanTextContent('docs/example.md', 'path = C:\\Users\\alice\\Documents\\key.pem');
  assert.equal(winFindings.length, 1);
  assert.equal(winFindings[0].label, 'personal Windows user path');

  const doubleSlashWin = scanTextContent('docs/example.md', 'path = "D:\\\\Users\\\\dev_user\\\\work"');
  assert.equal(doubleSlashWin.length, 1);

  const macFindings = scanTextContent('docs/example.md', 'root = /Users/bob/projects/ubgops');
  assert.equal(macFindings.length, 1);
  assert.equal(macFindings[0].label, 'personal Unix user path');

  const linuxFindings = scanTextContent('scripts/run.sh', 'cp /home/deploy_user/.ssh/id_ed25519 /tmp');
  assert.equal(linuxFindings.length, 1);
  assert.equal(linuxFindings[0].label, 'personal Unix user path');

  const tokenFindings = scanTextContent('src/leak.ts', 'const t = "ghp_1234567890abcdef";');
  assert.equal(tokenFindings.length, 1);
  assert.equal(tokenFindings[0].label, 'GitHub token prefix');
  assert.equal(Object.hasOwn(tokenFindings[0], 'match'), false);
});

test('policy allows legitimate test fixtures, placeholders, and non-sensitive paths', () => {
  assert.equal(
    scanTextContent('apps/desktop/src/features/files/FilesWorkspace.test.tsx', "destinationDisplay: 'C:\\\\Users\\\\owner\\\\Downloads\\\\file.bin'").length,
    0,
  );
  assert.equal(
    scanTextContent('apps/desktop/src/features/files/FilesWorkspace.test.tsx', "rootPath: '/home/test'").length,
    0,
  );
  assert.equal(
    scanTextContent('tools/openssh-fixture/configure.sh', 'install -d -m 700 "/home/$fixture_user/.ssh"').length,
    0,
  );
  assert.equal(
    scanTextContent('apps/desktop/src/features/hosts/HostForm.tsx', 'placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"').length,
    0,
  );
  assert.equal(isLikelyBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])), true);
  assert.equal(isLikelyBinary(Buffer.from('plain utf8 text\n', 'utf8')), false);
});
