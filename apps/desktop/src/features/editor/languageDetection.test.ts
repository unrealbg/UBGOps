import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_LANGUAGES,
  detectRemoteFileLanguage,
  getLanguageById,
} from './languageDetection';

describe('remote file language detection', () => {
  it('identifies all required programming, markup, scripting, and infra config languages including C# and extensionless configs', () => {
    const cases: Array<[string, string]> = [
      ['/srv/app/Program.cs', 'csharp'],
      ['/srv/app/scripts/deploy.csx', 'csharp'],
      ['/srv/app/src/daemon.c', 'c'],
      ['/srv/app/include/daemon.h', 'c'],
      ['/srv/app/src/worker.cpp', 'cpp'],
      ['/srv/app/include/worker.hpp', 'cpp'],
      ['/srv/app/src/main.rs', 'rust'],
      ['/opt/scripts/sync.py', 'python'],
      ['/srv/app/src/Main.java', 'java'],
      ['/srv/web/server.mjs', 'javascript'],
      ['/srv/web/app.ts', 'typescript'],
      ['/srv/cmd/server.go', 'go'],
      ['/var/www/html/index.php', 'php'],
      ['/usr/local/bin/deploy.sh', 'shell'],
      ['/home/test/.bashrc', 'shell'],
      ['/opt/scripts/check.ps1', 'powershell'],
      ['/opt/db/schema.sql', 'sql'],
      ['/etc/app/settings.json', 'json'],
      ['/opt/app/docker-compose.yml', 'yaml'],
      ['/srv/app/Cargo.toml', 'toml'],
      ['/srv/app/pyproject.toml', 'toml'],
      ['/etc/app/pom.xml', 'xml'],
      ['/srv/app/App.csproj', 'xml'],
      ['/var/www/html/index.html', 'html'],
      ['/var/www/html/site.css', 'css'],
      ['/srv/app/README.md', 'markdown'],
      ['/opt/app/Dockerfile', 'dockerfile'],
      ['/opt/app/Dockerfile.prod', 'dockerfile'],
      ['/etc/php/php.ini', 'ini'],
      ['/etc/ssh/sshd_config', 'ini'],
      ['/opt/infra/main.tf', 'hcl'],
      ['/etc/systemd/system/app.service', 'systemd'],
      ['/etc/systemd/system/app.service.d/override.conf', 'systemd'],
      ['/etc/nginx/nginx.conf', 'nginx'],
      ['/etc/nginx/sites-available/default', 'nginx'],
      ['/etc/apache2/apache2.conf', 'apacheconf'],
      ['/etc/apache2/sites-available/000-default', 'apacheconf'],
      ['/var/www/app/.htaccess', 'apacheconf'],
      ['/srv/app/.env', 'dotenv'],
      ['/srv/app/.env.production', 'dotenv'],
      ['/etc/environment', 'dotenv'],
      ['/var/log/app.log', 'plaintext'],
    ];

    for (const [remotePath, expectedId] of cases) {
      expect(detectRemoteFileLanguage(remotePath).id, `path=${remotePath}`).toBe(expectedId);
    }
  });

  it('exposes Plain Text explicitly in SUPPORTED_LANGUAGES and resolves overrides safely', () => {
    expect(SUPPORTED_LANGUAGES.some((lang) => lang.id === 'plaintext' && lang.label === 'Plain Text')).toBe(true);
    expect(SUPPORTED_LANGUAGES.some((lang) => lang.id === 'csharp' && lang.label === 'C#')).toBe(true);
    expect(getLanguageById('csharp')).toEqual({ id: 'csharp', label: 'C#' });
    expect(getLanguageById('unknown-lang-id')).toEqual({ id: 'plaintext', label: 'Plain Text' });
    expect(detectRemoteFileLanguage('/var/log/custom.unknownext')).toEqual({
      id: 'plaintext',
      label: 'Plain Text',
    });
  });
});
