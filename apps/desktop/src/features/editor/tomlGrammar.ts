import type * as monacoApi from 'monaco-editor/editor/editor.api';

let registered = false;

export function registerTomlLanguage(monaco: typeof monacoApi) {
  if (registered) return;
  registered = true;

  monaco.languages.register({
    id: 'toml',
    extensions: ['.toml'],
    aliases: ['TOML', 'toml'],
  });

  monaco.languages.setLanguageConfiguration('toml', {
    comments: { lineComment: '#' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider('toml', {
    defaultToken: '',
    tokenPostfix: '.toml',
    brackets: [
      { open: '[', close: ']', token: 'delimiter.bracket' },
      { open: '{', close: '}', token: 'delimiter.curly' },
    ],
    tokenizer: {
      root: [
        [/[ \t\r\n]+/, 'white'],
        [/#.*$/, 'comment'],
        [/^\s*\[\[[^\]]+\]\]/, 'type.identifier'],
        [/^\s*\[[^\]]+\]/, 'type.identifier'],
        [/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)(\s*)(=)/, ['key', 'white', 'delimiter']],
        [/"""/, { token: 'string.quote', next: '@multilineBasicString' }],
        [/'''/, { token: 'string.quote', next: '@multilineLiteralString' }],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/\b(true|false)\b/, 'keyword'],
        [/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/, 'number'],
        [/[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?|inf|nan)\b/, 'number'],
        [/[{}[\],.=]/, 'delimiter'],
      ],
      multilineBasicString: [
        [/"""/, { token: 'string.quote', next: '@pop' }],
        [/\\./, 'string.escape'],
        [/[^"\\]+/, 'string'],
        [/"/, 'string'],
      ],
      multilineLiteralString: [
        [/'''/, { token: 'string.quote', next: '@pop' }],
        [/[^']+/, 'string'],
        [/'/, 'string'],
      ],
    },
  });
}
