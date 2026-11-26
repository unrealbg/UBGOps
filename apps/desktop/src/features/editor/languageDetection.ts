export interface DetectedLanguage {
  readonly id: string;
  readonly label: string;
}

export const SUPPORTED_LANGUAGES: readonly DetectedLanguage[] = [
  { id: 'plaintext', label: 'Plain Text' },
  { id: 'csharp', label: 'C#' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'rust', label: 'Rust' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'go', label: 'Go' },
  { id: 'php', label: 'PHP' },
  { id: 'shell', label: 'Bash / Shell' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'sql', label: 'SQL' },
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'toml', label: 'TOML' },
  { id: 'xml', label: 'XML' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'dockerfile', label: 'Dockerfile' },
  { id: 'ini', label: 'INI / Config' },
  { id: 'hcl', label: 'HCL / Terraform' },
  { id: 'systemd', label: 'Systemd Unit' },
  { id: 'nginx', label: 'Nginx Config' },
  { id: 'apacheconf', label: 'Apache Config' },
  { id: 'dotenv', label: 'Environment (.env)' },
];

const LANGUAGE_BY_ID: ReadonlyMap<string, DetectedLanguage> = new Map(
  SUPPORTED_LANGUAGES.map((entry) => [entry.id, entry]),
);

export function getLanguageById(languageId: string): DetectedLanguage {
  return LANGUAGE_BY_ID.get(languageId) ?? { id: 'plaintext', label: 'Plain Text' };
}

const BASENAME_MAP: Record<string, DetectedLanguage> = {
  dockerfile: { id: 'dockerfile', label: 'Dockerfile' },
  containerfile: { id: 'dockerfile', label: 'Dockerfile' },
  'cargo.toml': { id: 'toml', label: 'TOML' },
  'pyproject.toml': { id: 'toml', label: 'TOML' },
  'poetry.lock': { id: 'toml', label: 'TOML' },
  'cargo.lock': { id: 'toml', label: 'TOML' },
  '.bashrc': { id: 'shell', label: 'Bash / Shell' },
  '.bash_profile': { id: 'shell', label: 'Bash / Shell' },
  '.bash_logout': { id: 'shell', label: 'Bash / Shell' },
  '.profile': { id: 'shell', label: 'Bash / Shell' },
  '.zshrc': { id: 'shell', label: 'Bash / Shell' },
  '.zprofile': { id: 'shell', label: 'Bash / Shell' },
  '.zshenv': { id: 'shell', label: 'Bash / Shell' },
  bashrc: { id: 'shell', label: 'Bash / Shell' },
  profile: { id: 'shell', label: 'Bash / Shell' },
  '.gitconfig': { id: 'ini', label: 'INI / Config' },
  '.editorconfig': { id: 'ini', label: 'INI / Config' },
  sshd_config: { id: 'ini', label: 'INI / Config' },
  ssh_config: { id: 'ini', label: 'INI / Config' },
  '.env': { id: 'dotenv', label: 'Environment (.env)' },
  '.envrc': { id: 'dotenv', label: 'Environment (.env)' },
  'nginx.conf': { id: 'nginx', label: 'Nginx Config' },
  'httpd.conf': { id: 'apacheconf', label: 'Apache Config' },
  'apache2.conf': { id: 'apacheconf', label: 'Apache Config' },
  'ports.conf': { id: 'apacheconf', label: 'Apache Config' },
  '.htaccess': { id: 'apacheconf', label: 'Apache Config' },
  '.htpasswd': { id: 'apacheconf', label: 'Apache Config' },
  '.babelrc': { id: 'json', label: 'JSON' },
  '.eslintrc': { id: 'json', label: 'JSON' },
  '.prettierrc': { id: 'json', label: 'JSON' },
  'composer.lock': { id: 'json', label: 'JSON' },
  'go.mod': { id: 'ini', label: 'INI / Config' },
  'go.sum': { id: 'plaintext', label: 'Plain Text' },
};

const EXTENSION_MAP: Record<string, DetectedLanguage> = {
  cs: { id: 'csharp', label: 'C#' },
  csx: { id: 'csharp', label: 'C#' },
  cake: { id: 'csharp', label: 'C#' },
  c: { id: 'c', label: 'C' },
  h: { id: 'c', label: 'C' },
  cpp: { id: 'cpp', label: 'C++' },
  cc: { id: 'cpp', label: 'C++' },
  cxx: { id: 'cpp', label: 'C++' },
  hpp: { id: 'cpp', label: 'C++' },
  hh: { id: 'cpp', label: 'C++' },
  hxx: { id: 'cpp', label: 'C++' },
  rs: { id: 'rust', label: 'Rust' },
  py: { id: 'python', label: 'Python' },
  pyw: { id: 'python', label: 'Python' },
  pyi: { id: 'python', label: 'Python' },
  java: { id: 'java', label: 'Java' },
  jav: { id: 'java', label: 'Java' },
  js: { id: 'javascript', label: 'JavaScript' },
  mjs: { id: 'javascript', label: 'JavaScript' },
  cjs: { id: 'javascript', label: 'JavaScript' },
  jsx: { id: 'javascript', label: 'JavaScript' },
  ts: { id: 'typescript', label: 'TypeScript' },
  mts: { id: 'typescript', label: 'TypeScript' },
  cts: { id: 'typescript', label: 'TypeScript' },
  tsx: { id: 'typescript', label: 'TypeScript' },
  go: { id: 'go', label: 'Go' },
  php: { id: 'php', label: 'PHP' },
  phtml: { id: 'php', label: 'PHP' },
  php4: { id: 'php', label: 'PHP' },
  php5: { id: 'php', label: 'PHP' },
  php7: { id: 'php', label: 'PHP' },
  phps: { id: 'php', label: 'PHP' },
  sh: { id: 'shell', label: 'Bash / Shell' },
  bash: { id: 'shell', label: 'Bash / Shell' },
  zsh: { id: 'shell', label: 'Bash / Shell' },
  ksh: { id: 'shell', label: 'Bash / Shell' },
  ps1: { id: 'powershell', label: 'PowerShell' },
  psm1: { id: 'powershell', label: 'PowerShell' },
  psd1: { id: 'powershell', label: 'PowerShell' },
  sql: { id: 'sql', label: 'SQL' },
  json: { id: 'json', label: 'JSON' },
  jsonc: { id: 'json', label: 'JSON' },
  yml: { id: 'yaml', label: 'YAML' },
  yaml: { id: 'yaml', label: 'YAML' },
  toml: { id: 'toml', label: 'TOML' },
  xml: { id: 'xml', label: 'XML' },
  plist: { id: 'xml', label: 'XML' },
  xhtml: { id: 'xml', label: 'XML' },
  svg: { id: 'xml', label: 'XML' },
  csproj: { id: 'xml', label: 'XML' },
  vbproj: { id: 'xml', label: 'XML' },
  fsproj: { id: 'xml', label: 'XML' },
  props: { id: 'xml', label: 'XML' },
  targets: { id: 'xml', label: 'XML' },
  nuspec: { id: 'xml', label: 'XML' },
  xaml: { id: 'xml', label: 'XML' },
  config: { id: 'xml', label: 'XML' },
  html: { id: 'html', label: 'HTML' },
  htm: { id: 'html', label: 'HTML' },
  shtml: { id: 'html', label: 'HTML' },
  css: { id: 'css', label: 'CSS' },
  md: { id: 'markdown', label: 'Markdown' },
  markdown: { id: 'markdown', label: 'Markdown' },
  mdx: { id: 'markdown', label: 'Markdown' },
  dockerfile: { id: 'dockerfile', label: 'Dockerfile' },
  ini: { id: 'ini', label: 'INI / Config' },
  conf: { id: 'ini', label: 'INI / Config' },
  cfg: { id: 'ini', label: 'INI / Config' },
  cnf: { id: 'ini', label: 'INI / Config' },
  properties: { id: 'ini', label: 'INI / Config' },
  tf: { id: 'hcl', label: 'HCL / Terraform' },
  tfvars: { id: 'hcl', label: 'HCL / Terraform' },
  hcl: { id: 'hcl', label: 'HCL / Terraform' },
  service: { id: 'systemd', label: 'Systemd Unit' },
  socket: { id: 'systemd', label: 'Systemd Unit' },
  timer: { id: 'systemd', label: 'Systemd Unit' },
  target: { id: 'systemd', label: 'Systemd Unit' },
  mount: { id: 'systemd', label: 'Systemd Unit' },
  automount: { id: 'systemd', label: 'Systemd Unit' },
  swap: { id: 'systemd', label: 'Systemd Unit' },
  path: { id: 'systemd', label: 'Systemd Unit' },
  slice: { id: 'systemd', label: 'Systemd Unit' },
  scope: { id: 'systemd', label: 'Systemd Unit' },
  unit: { id: 'systemd', label: 'Systemd Unit' },
  network: { id: 'systemd', label: 'Systemd Unit' },
  netdev: { id: 'systemd', label: 'Systemd Unit' },
  link: { id: 'systemd', label: 'Systemd Unit' },
  nginx: { id: 'nginx', label: 'Nginx Config' },
  env: { id: 'dotenv', label: 'Environment (.env)' },
  txt: { id: 'plaintext', label: 'Plain Text' },
  log: { id: 'plaintext', label: 'Plain Text' },
};

function detectFromDirectoryContext(lowerPath: string, lowerName: string): DetectedLanguage | null {
  if (
    lowerPath.includes('/etc/nginx/') ||
    lowerPath.includes('/nginx/sites-available/') ||
    lowerPath.includes('/nginx/sites-enabled/') ||
    lowerPath.includes('/nginx/conf.d/') ||
    lowerPath.includes('/nginx/streams-enabled/')
  ) {
    return { id: 'nginx', label: 'Nginx Config' };
  }

  if (
    lowerPath.includes('/etc/apache2/') ||
    lowerPath.includes('/etc/httpd/conf/') ||
    lowerPath.includes('/etc/httpd/conf.d/') ||
    lowerPath.includes('/apache2/sites-available/') ||
    lowerPath.includes('/apache2/sites-enabled/') ||
    lowerPath.includes('/apache2/conf-available/') ||
    lowerPath.includes('/apache2/conf-enabled/') ||
    lowerPath.includes('/apache2/mods-available/') ||
    lowerPath.includes('/apache2/mods-enabled/')
  ) {
    return { id: 'apacheconf', label: 'Apache Config' };
  }

  if (lowerPath.includes('/systemd/') && lowerName.endsWith('.conf')) {
    return { id: 'systemd', label: 'Systemd Unit' };
  }

  if (lowerPath === '/etc/environment' || /\/etc\/default\/[^/]+$/.test(lowerPath)) {
    return { id: 'dotenv', label: 'Environment (.env)' };
  }

  return null;
}

export function detectRemoteFileLanguage(remotePath: string): DetectedLanguage {
  const normalizedPath = remotePath.trim().replaceAll('\\', '/').toLowerCase();
  const slashIndex = normalizedPath.lastIndexOf('/');
  const lowerName = (slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath).trim();

  if (lowerName.startsWith('dockerfile.')) {
    return { id: 'dockerfile', label: 'Dockerfile' };
  }
  if (lowerName.startsWith('.env.')) {
    return { id: 'dotenv', label: 'Environment (.env)' };
  }

  const exactMatch = BASENAME_MAP[lowerName];
  if (exactMatch) return exactMatch;

  const dotIndex = lowerName.lastIndexOf('.');
  const ext = dotIndex > 0 && dotIndex < lowerName.length - 1 ? lowerName.slice(dotIndex + 1) : '';
  const extMatch = ext ? EXTENSION_MAP[ext] : undefined;
  // Explicit non-.conf extensions (e.g. README.md, check.sh, script.py inside /etc/nginx)
  // take precedence over generic Nginx/Apache directory context, while preserving .conf
  // and extensionless vhost/unit files in those directories.
  if (extMatch && ext !== 'conf') {
    return extMatch;
  }

  const contextMatch = detectFromDirectoryContext(normalizedPath, lowerName);
  if (contextMatch) return contextMatch;

  if (extMatch) return extMatch;

  return { id: 'plaintext', label: 'Plain Text' };
}
