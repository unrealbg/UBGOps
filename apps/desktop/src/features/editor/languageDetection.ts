export interface DetectedLanguage {
  readonly id: string;
  readonly label: string;
}

const BASENAME_MAP: Record<string, DetectedLanguage> = {
  dockerfile: { id: 'dockerfile', label: 'Dockerfile' },
  containerfile: { id: 'dockerfile', label: 'Dockerfile' },
  'cargo.toml': { id: 'toml', label: 'TOML' },
  'pyproject.toml': { id: 'toml', label: 'TOML' },
  'poetry.lock': { id: 'toml', label: 'TOML' },
  'cargo.lock': { id: 'toml', label: 'TOML' },
  '.bashrc': { id: 'shell', label: 'Shell' },
  '.bash_profile': { id: 'shell', label: 'Shell' },
  '.profile': { id: 'shell', label: 'Shell' },
  '.zshrc': { id: 'shell', label: 'Shell' },
  '.zprofile': { id: 'shell', label: 'Shell' },
  '.gitconfig': { id: 'ini', label: 'Config / INI' },
  '.editorconfig': { id: 'ini', label: 'Config / INI' },
  '.env': { id: 'ini', label: 'Config / INI' },
  sshd_config: { id: 'ini', label: 'Config / INI' },
  ssh_config: { id: 'ini', label: 'Config / INI' },
  'nginx.conf': { id: 'ini', label: 'Config / INI' },
};

const EXTENSION_MAP: Record<string, DetectedLanguage> = {
  yml: { id: 'yaml', label: 'YAML' },
  yaml: { id: 'yaml', label: 'YAML' },
  json: { id: 'json', label: 'JSON' },
  toml: { id: 'toml', label: 'TOML' },
  sh: { id: 'shell', label: 'Shell' },
  bash: { id: 'shell', label: 'Shell' },
  zsh: { id: 'shell', label: 'Shell' },
  ksh: { id: 'shell', label: 'Shell' },
  ini: { id: 'ini', label: 'INI' },
  conf: { id: 'ini', label: 'Config / INI' },
  cfg: { id: 'ini', label: 'Config / INI' },
  cnf: { id: 'ini', label: 'Config / INI' },
  properties: { id: 'ini', label: 'Properties' },
  service: { id: 'ini', label: 'Systemd Unit' },
  socket: { id: 'ini', label: 'Systemd Unit' },
  timer: { id: 'ini', label: 'Systemd Unit' },
  target: { id: 'ini', label: 'Systemd Unit' },
  mount: { id: 'ini', label: 'Systemd Unit' },
  unit: { id: 'ini', label: 'Systemd Unit' },
  env: { id: 'ini', label: 'Environment' },
  dockerfile: { id: 'dockerfile', label: 'Dockerfile' },
  tf: { id: 'hcl', label: 'HCL / Terraform' },
  tfvars: { id: 'hcl', label: 'HCL / Terraform' },
  hcl: { id: 'hcl', label: 'HCL' },
  ps1: { id: 'powershell', label: 'PowerShell' },
  psm1: { id: 'powershell', label: 'PowerShell' },
  psd1: { id: 'powershell', label: 'PowerShell' },
  md: { id: 'markdown', label: 'Markdown' },
  markdown: { id: 'markdown', label: 'Markdown' },
  xml: { id: 'xml', label: 'XML' },
  plist: { id: 'xml', label: 'XML / Plist' },
  xhtml: { id: 'xml', label: 'XHTML' },
  svg: { id: 'xml', label: 'SVG / XML' },
  sql: { id: 'sql', label: 'SQL' },
  py: { id: 'python', label: 'Python' },
  pyw: { id: 'python', label: 'Python' },
  js: { id: 'javascript', label: 'JavaScript' },
  mjs: { id: 'javascript', label: 'JavaScript' },
  cjs: { id: 'javascript', label: 'JavaScript' },
  ts: { id: 'typescript', label: 'TypeScript' },
  mts: { id: 'typescript', label: 'TypeScript' },
  cts: { id: 'typescript', label: 'TypeScript' },
  c: { id: 'c', label: 'C' },
  h: { id: 'c', label: 'C Header' },
  cpp: { id: 'cpp', label: 'C++' },
  cc: { id: 'cpp', label: 'C++' },
  cxx: { id: 'cpp', label: 'C++' },
  hpp: { id: 'cpp', label: 'C++ Header' },
  hh: { id: 'cpp', label: 'C++ Header' },
  hxx: { id: 'cpp', label: 'C++ Header' },
  rs: { id: 'rust', label: 'Rust' },
  txt: { id: 'plaintext', label: 'Plain Text' },
  log: { id: 'plaintext', label: 'Log / Plain Text' },
};

export function detectRemoteFileLanguage(remotePath: string): DetectedLanguage {
  const slashIndex = remotePath.lastIndexOf('/');
  const rawName = (slashIndex >= 0 ? remotePath.slice(slashIndex + 1) : remotePath).trim();
  const lowerName = rawName.toLowerCase();

  const exactMatch = BASENAME_MAP[lowerName];
  if (exactMatch) return exactMatch;

  if (lowerName.startsWith('dockerfile.')) {
    return { id: 'dockerfile', label: 'Dockerfile' };
  }
  if (lowerName.startsWith('.env.')) {
    return { id: 'ini', label: 'Environment' };
  }

  const dotIndex = lowerName.lastIndexOf('.');
  if (dotIndex > 0 && dotIndex < lowerName.length - 1) {
    const ext = lowerName.slice(dotIndex + 1);
    const extMatch = EXTENSION_MAP[ext];
    if (extMatch) return extMatch;
  }

  return { id: 'plaintext', label: 'Plain Text' };
}
