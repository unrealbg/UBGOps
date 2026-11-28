import { describe, expect, it } from 'vitest';
import {
  MAX_EDITOR_PAYLOAD_BYTES,
  MAX_LOCAL_BUFFER_BYTES,
  calculateEncodedBytes,
  evaluateMultiCursorPaste,
  hasLoneSurrogate,
  isPasteAllowed,
  normalizePasteToLf,
  validateEditableText,
} from './textCodec';

describe('textCodec UTF-8, surrogate, CRLF, BOM, and multi-cursor bounds', () => {
  it('detects unpaired UTF-16 surrogates while allowing valid astral pairs', () => {
    expect(hasLoneSurrogate('plain ascii\n')).toBe(false);
    expect(hasLoneSurrogate('Здравей 😀🚀\n')).toBe(false);
    expect(hasLoneSurrogate('high\uD800only')).toBe(true);
    expect(hasLoneSurrogate('low\uDC00only')).toBe(true);
    expect(hasLoneSurrogate('reversed\uDC00\uD800')).toBe(true);

    const validation = validateEditableText('hello\uD800world', 'lf', false);
    expect(validation.canHoldLocally).toBe(false);
    expect(validation.canSave).toBe(false);
    expect(validation.reason).toMatch(/surrogates/i);
  });

  it('calculates BOM (+3) and CRLF (+1 per line break) byte sizes accurately', () => {
    const lf = calculateEncodedBytes('a\nb\n', 'lf', false);
    expect(lf).toMatchObject({ lfUtf8Bytes: 4, bomBytes: 0, crlfExpansionBytes: 0, encodedBytes: 4 });

    const crlfBom = calculateEncodedBytes('a\nb\n', 'crLf', true);
    expect(crlfBom).toMatchObject({
      lfUtf8Bytes: 4,
      bomBytes: 3,
      crlfExpansionBytes: 2,
      encodedBytes: 9,
      lineCount: 3,
    });

    const overSave = 'a'.repeat(MAX_EDITOR_PAYLOAD_BYTES + 1);
    const overSaveValidation = validateEditableText(overSave, 'lf', false);
    expect(overSaveValidation.canHoldLocally).toBe(true);
    expect(overSaveValidation.canSave).toBe(false);

    const overLocal = 'a'.repeat(MAX_LOCAL_BUFFER_BYTES + 1);
    const overLocalValidation = validateEditableText(overLocal, 'lf', false);
    expect(overLocalValidation.canHoldLocally).toBe(false);
    expect(overLocalValidation.canSave).toBe(false);
  });

  it('normalizes pasted line endings and accounts accurately for UTF-8 selection replacement', () => {
    expect(normalizePasteToLf('a\r\nb\rc')).toBe('a\nb\nc');

    // 524,280 x 3-byte UTF-8 CJK characters = 1,572,840 bytes (within 1.5 MiB).
    // Replacing the full selection with 1,048,600 ASCII bytes results in 1,048,600 bytes (< 1.5 MiB).
    const cjkBuffer = '中'.repeat(524_280);
    const replacement = 'a'.repeat(1_048_600);
    const multiByteSelectionGate = isPasteAllowed(cjkBuffer, replacement, [cjkBuffer], 'lf', false);
    expect(multiByteSelectionGate.allowed).toBe(true);
  });

  it('evaluates multi-cursor paste distribution (N lines -> N cursors vs full paste per cursor)', () => {
    // 4 cursors pasting 500,000 single-line bytes each => 2,000,000 bytes > 1,572,864 limit.
    const rejected = evaluateMultiCursorPaste(
      'clean\n',
      'x'.repeat(500_000),
      ['', '', '', ''],
      'lf',
      false,
    );
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toMatch(/1,572,864/);

    // 3 cursors pasting 3 lines (1 line distributed per cursor) => total 900,000 bytes <= limit.
    const linePerCursor = ['a'.repeat(300_000), 'b'.repeat(300_000), 'c'.repeat(300_000)].join('\n');
    const distributed = evaluateMultiCursorPaste(
      'clean\n',
      linePerCursor,
      ['', '', ''],
      'lf',
      false,
    );
    expect(distributed.allowed).toBe(true);
  });
});
