import { describe, expect, it } from 'vitest';
import { detectRemoteFileLanguage } from './languageDetection';

describe('remote file language detection', () => {
  it('identifies curated infrastructure configs plus C, C++, Rust and TOML', () => {
    expect(detectRemoteFileLanguage('/etc/nginx/nginx.conf').id).toBe('ini');
    expect(detectRemoteFileLanguage('/etc/systemd/system/app.service').id).toBe('ini');
    expect(detectRemoteFileLanguage('/opt/app/docker-compose.yml').id).toBe('yaml');
    expect(detectRemoteFileLanguage('/opt/app/Dockerfile').id).toBe('dockerfile');
    expect(detectRemoteFileLanguage('/etc/app/settings.json').id).toBe('json');
    expect(detectRemoteFileLanguage('/opt/infra/main.tf').id).toBe('hcl');
    expect(detectRemoteFileLanguage('/usr/local/bin/deploy.sh').id).toBe('shell');
    expect(detectRemoteFileLanguage('/opt/scripts/check.ps1').id).toBe('powershell');
    expect(detectRemoteFileLanguage('/srv/app/Cargo.toml').id).toBe('toml');
    expect(detectRemoteFileLanguage('/srv/app/pyproject.toml').id).toBe('toml');
    expect(detectRemoteFileLanguage('/srv/app/src/main.rs').id).toBe('rust');
    expect(detectRemoteFileLanguage('/srv/app/src/daemon.c').id).toBe('c');
    expect(detectRemoteFileLanguage('/srv/app/include/daemon.h').id).toBe('c');
    expect(detectRemoteFileLanguage('/srv/app/src/worker.cpp').id).toBe('cpp');
    expect(detectRemoteFileLanguage('/srv/app/include/worker.hpp').id).toBe('cpp');
  });

  it('falls back to plaintext for unknown extensions', () => {
    expect(detectRemoteFileLanguage('/var/log/custom.unknownext')).toEqual({
      id: 'plaintext',
      label: 'Plain Text',
    });
  });
});
