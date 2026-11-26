import type * as monacoApi from 'monaco-editor/editor/editor.api';

let registered = false;

export function registerCustomInfraLanguages(monaco: typeof monacoApi): void {
  if (registered) return;
  registered = true;

  registerSystemdLanguage(monaco);
  registerNginxLanguage(monaco);
  registerApacheLanguage(monaco);
  registerDotenvLanguage(monaco);
}

function registerSystemdLanguage(monaco: typeof monacoApi): void {
  monaco.languages.register({
    id: 'systemd',
    extensions: [
      '.service',
      '.socket',
      '.timer',
      '.target',
      '.mount',
      '.automount',
      '.swap',
      '.path',
      '.slice',
      '.scope',
      '.unit',
      '.network',
      '.netdev',
      '.link',
    ],
    aliases: ['Systemd Unit', 'systemd'],
  });

  monaco.languages.setLanguageConfiguration('systemd', {
    comments: { lineComment: '#' },
    brackets: [['[', ']']],
    autoClosingPairs: [
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider('systemd', {
    defaultToken: '',
    tokenPostfix: '.systemd',
    tokenizer: {
      root: [
        [/^\s*[#;].*$/, 'comment'],
        [/^\s*\[[A-Za-z0-9_.-]+\]/, 'type.identifier'],
        [/^([A-Za-z][A-Za-z0-9_-]*)(\s*)(=)/, ['key', 'white', 'delimiter']],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/%[a-zA-Z%]/, 'variable'],
        [/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/, 'variable'],
        [
          /\b(true|false|yes|no|on|off|simple|exec|forking|oneshot|dbus|notify|notify-reload|idle|always|on-failure|on-abnormal|on-abort|on-watchdog|multi-user\.target|network\.target|mixed|control-group|process|none)\b/,
          'keyword',
        ],
        [/\b\d+(?:\.\d+)?(?:us|ms|s|m|h|d|w|K|M|G|T)?\b/, 'number'],
        [/[=/]/, 'delimiter'],
      ],
    },
  });
}

function registerNginxLanguage(monaco: typeof monacoApi): void {
  monaco.languages.register({
    id: 'nginx',
    extensions: ['.nginx'],
    filenames: ['nginx.conf'],
    aliases: ['Nginx Config', 'nginx'],
  });

  monaco.languages.setLanguageConfiguration('nginx', {
    comments: { lineComment: '#' },
    brackets: [
      ['{', '}'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider('nginx', {
    defaultToken: '',
    tokenPostfix: '.nginx',
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/, 'variable'],
        [
          /\b(http|server|location|upstream|events|stream|mail|geo|map|types|if|limit_except|split_clients|match|server_name|listen|root|index|try_files|proxy_pass|proxy_set_header|proxy_http_version|proxy_read_timeout|fastcgi_pass|include|error_log|access_log|worker_processes|worker_connections|ssl_certificate|ssl_certificate_key|ssl_protocols|ssl_ciphers|add_header|return|rewrite|gzip|sendfile|keepalive_timeout|client_max_body_size|default_type|resolver|alias|deny|allow|auth_basic)\b/,
          'keyword',
        ],
        [/\b(on|off|default_server|ssl|http2|permanent|redirect|break|last|main)\b/, 'type.identifier'],
        [/\b\d+(?:\.\d+)?(?:k|K|m|M|g|G|ms|s|m|h|d|w|y)?\b/, 'number'],
        [/[{}();~*=]/, 'delimiter'],
      ],
    },
  });
}

function registerApacheLanguage(monaco: typeof monacoApi): void {
  monaco.languages.register({
    id: 'apacheconf',
    filenames: ['httpd.conf', 'apache2.conf', 'ports.conf', '.htaccess', '.htpasswd'],
    aliases: ['Apache Config', 'apacheconf'],
  });

  monaco.languages.setLanguageConfiguration('apacheconf', {
    comments: { lineComment: '#' },
    brackets: [
      ['<', '>'],
      ['"', '"'],
    ],
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider('apacheconf', {
    defaultToken: '',
    tokenPostfix: '.apacheconf',
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/<\/?[A-Za-z][A-Za-z0-9_-]*/, { token: 'tag', next: '@tagBlock' }],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/%\{[^}]+\}|\$\{[^}]+\}/, 'variable'],
        [
          /\b(ServerRoot|ServerName|ServerAlias|ServerAdmin|Listen|DocumentRoot|DirectoryIndex|Options|AllowOverride|Require|Order|Allow|Deny|ProxyPass|ProxyPassReverse|ProxyPreserveHost|RewriteEngine|RewriteCond|RewriteRule|Redirect|RedirectMatch|ErrorLog|CustomLog|LogLevel|LoadModule|Include|IncludeOptional|Define|SetEnv|SetEnvIf|Header|ExpiresActive|ExpiresByType|SSLEngine|SSLCertificateFile|SSLCertificateKeyFile|SSLProtocol|SSLCipherSuite|Alias|ScriptAlias|AuthType|AuthName|AuthUserFile)\b/,
          'keyword',
        ],
        [/\b(On|Off|All|None|Any|Granted|Denied|Full|Prod|OS|Minimal|Indexes|FollowSymLinks|MultiViews|ExecCGI)\b/i, 'type.identifier'],
        [/\b\d+\b/, 'number'],
      ],
      tagBlock: [
        [/>/, { token: 'tag', next: '@pop' }],
        [/"([^"\\]|\\.)*"/, 'attribute.value'],
        [/[^>\s"]+/, 'attribute.name'],
      ],
    },
  });
}

function registerDotenvLanguage(monaco: typeof monacoApi): void {
  monaco.languages.register({
    id: 'dotenv',
    extensions: ['.env'],
    filenames: ['.env', '.envrc'],
    aliases: ['Environment (.env)', 'dotenv'],
  });

  monaco.languages.setLanguageConfiguration('dotenv', {
    comments: { lineComment: '#' },
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider('dotenv', {
    defaultToken: '',
    tokenPostfix: '.dotenv',
    tokenizer: {
      root: [
        [/^\s*#.*$/, 'comment'],
        [/^(\s*)(export)(\s+)([A-Za-z_][A-Za-z0-9_.-]*)(\s*)(=)/, ['white', 'keyword', 'white', 'key', 'white', 'delimiter']],
        [/^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)(\s*)(=)/, ['white', 'key', 'white', 'delimiter']],
        [/"/, { token: 'string.quote', next: '@doubleQuoted' }],
        [/'[^']*'/, 'string'],
        [/\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/, 'variable'],
        [/#.*$/, 'comment'],
        [/\b(true|false|yes|no|on|off|null)\b/i, 'keyword'],
        [/\b\d+(?:\.\d+)?\b/, 'number'],
      ],
      doubleQuoted: [
        [/\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/, 'variable'],
        [/\\./, 'string.escape'],
        [/"/, { token: 'string.quote', next: '@pop' }],
        [/[^"$\\]+/, 'string'],
        [/./, 'string'],
      ],
    },
  });
}
