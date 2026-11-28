import type { TextNewline } from '@ubgops/protocol';

export const MAX_EDITOR_PAYLOAD_BYTES = 1_048_576;
export const MAX_LOCAL_BUFFER_BYTES = 1_572_864;
export const MAX_UNDO_HISTORY_BYTES = 4 * 1024 * 1024;
export const MAX_UNDO_STEPS = 500;

const utf8Encoder = new TextEncoder();

export interface EncodedPayloadMetrics {
  lfUtf8Bytes: number;
  encodedBytes: number;
  bomBytes: number;
  crlfExpansionBytes: number;
  lineCount: number;
  hasNul: boolean;
  hasBareCr: boolean;
  hasLoneSurrogate: boolean;
  exceedsPayloadCap: boolean;
  exceedsLocalBufferCap: boolean;
}

export interface EditableTextValidation {
  canHoldLocally: boolean;
  canSave: boolean;
  reason: string | null;
  metrics: EncodedPayloadMetrics;
}

export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function normalizePasteToLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function countLinesLf(text: string): number {
  let count = 1;
  let index = -1;
  while ((index = text.indexOf('\n', index + 1)) !== -1) {
    count += 1;
  }
  return count;
}

export function calculateEncodedBytes(
  text: string,
  newline: TextNewline,
  bom: boolean,
): EncodedPayloadMetrics {
  const hasNul = text.includes('\0');
  const hasBareCr = text.includes('\r');
  const loneSurrogate = hasLoneSurrogate(text);
  const lfUtf8Bytes = utf8Encoder.encode(text).length;
  const lineBreaks = countLinesLf(text) - 1;
  const bomBytes = bom ? 3 : 0;
  const crlfExpansionBytes = newline === 'crLf' ? lineBreaks : 0;
  const encodedBytes = bomBytes + lfUtf8Bytes + crlfExpansionBytes;
  return {
    lfUtf8Bytes,
    encodedBytes,
    bomBytes,
    crlfExpansionBytes,
    lineCount: lineBreaks + 1,
    hasNul,
    hasBareCr,
    hasLoneSurrogate: loneSurrogate,
    exceedsPayloadCap: encodedBytes > MAX_EDITOR_PAYLOAD_BYTES,
    exceedsLocalBufferCap: encodedBytes > MAX_LOCAL_BUFFER_BYTES || lfUtf8Bytes > MAX_LOCAL_BUFFER_BYTES,
  };
}

export function validateEditableText(
  text: string,
  newline: TextNewline,
  bom: boolean,
): EditableTextValidation {
  const metrics = calculateEncodedBytes(text, newline, bom);
  if (metrics.hasNul) {
    return {
      canHoldLocally: false,
      canSave: false,
      reason: 'NUL bytes are not supported by the text editor.',
      metrics,
    };
  }
  if (metrics.hasBareCr) {
    return {
      canHoldLocally: false,
      canSave: false,
      reason: 'Bare CR line endings are not supported; editor buffers must remain LF-normalized.',
      metrics,
    };
  }
  if (metrics.hasLoneSurrogate) {
    return {
      canHoldLocally: false,
      canSave: false,
      reason: 'Unpaired UTF-16 surrogates are not supported by UTF-8 text editing.',
      metrics,
    };
  }
  if (metrics.exceedsLocalBufferCap) {
    return {
      canHoldLocally: false,
      canSave: false,
      reason: `Text exceeds the ${MAX_LOCAL_BUFFER_BYTES.toLocaleString()} byte local editor buffer ceiling.`,
      metrics,
    };
  }
  if (metrics.exceedsPayloadCap) {
    return {
      canHoldLocally: true,
      canSave: false,
      reason: `Encoded content (${metrics.encodedBytes.toLocaleString()} bytes) exceeds the 1 MiB (${MAX_EDITOR_PAYLOAD_BYTES.toLocaleString()} bytes) safe-save limit.`,
      metrics,
    };
  }
  return {
    canHoldLocally: true,
    canSave: true,
    reason: null,
    metrics,
  };
}

export function evaluateMultiCursorPaste(
  currentLfText: string,
  pastedRawText: string,
  replacedSelections: readonly string[],
  newline: TextNewline,
  bom: boolean,
): { allowed: boolean; normalizedText: string; reason: string | null } {
  if (pastedRawText.includes('\0')) {
    return {
      allowed: false,
      normalizedText: '',
      reason: 'NUL bytes cannot be pasted into the text editor.',
    };
  }
  if (hasLoneSurrogate(pastedRawText)) {
    return {
      allowed: false,
      normalizedText: '',
      reason: 'Unpaired UTF-16 surrogates cannot be pasted into the text editor.',
    };
  }
  const normalizedText = normalizePasteToLf(pastedRawText);
  const currentMetrics = calculateEncodedBytes(currentLfText, newline, bom);

  const cursorCount = Math.max(1, replacedSelections.length);
  let insertedLfBytes = 0;
  let insertedLineBreaks: number;

  if (cursorCount === 1) {
    const insertedMetrics = calculateEncodedBytes(normalizedText, newline, false);
    insertedLfBytes = insertedMetrics.lfUtf8Bytes;
    insertedLineBreaks = insertedMetrics.lineCount - 1;
  } else {
    const pasteLines = normalizedText.split('\n');
    if (pasteLines.length === cursorCount) {
      for (const line of pasteLines) {
        insertedLfBytes += utf8Encoder.encode(line).length;
      }
      insertedLineBreaks = 0;
    } else {
      const perCursor = calculateEncodedBytes(normalizedText, newline, false);
      insertedLfBytes = perCursor.lfUtf8Bytes * cursorCount;
      insertedLineBreaks = (perCursor.lineCount - 1) * cursorCount;
    }
  }

  let replacedLfBytes = 0;
  let replacedLineBreaks = 0;
  for (const selectionText of replacedSelections) {
    const selNormalized = normalizePasteToLf(selectionText);
    replacedLfBytes += utf8Encoder.encode(selNormalized).length;
    replacedLineBreaks += countLinesLf(selNormalized) - 1;
  }

  const resultingLfBytes = Math.max(0, currentMetrics.lfUtf8Bytes - replacedLfBytes + insertedLfBytes);
  const resultingLineBreaks = Math.max(0, (currentMetrics.lineCount - 1) - replacedLineBreaks + insertedLineBreaks);
  const resultingEncodedBytes =
    currentMetrics.bomBytes + resultingLfBytes + (newline === 'crLf' ? resultingLineBreaks : 0);

  if (resultingLfBytes <= MAX_LOCAL_BUFFER_BYTES && resultingEncodedBytes <= MAX_LOCAL_BUFFER_BYTES) {
    return { allowed: true, normalizedText, reason: null };
  }

  return {
    allowed: false,
    normalizedText: '',
    reason: `Paste rejected: resulting content would exceed the ${MAX_LOCAL_BUFFER_BYTES.toLocaleString()} byte local editor ceiling.`,
  };
}

export function isPasteAllowed(
  currentLfText: string,
  pastedRawText: string,
  replacedSelectionsOrUtf16: number | readonly string[],
  newline: TextNewline,
  bom: boolean,
): { allowed: boolean; normalizedText: string; reason: string | null } {
  if (Array.isArray(replacedSelectionsOrUtf16)) {
    return evaluateMultiCursorPaste(
      currentLfText,
      pastedRawText,
      replacedSelectionsOrUtf16,
      newline,
      bom,
    );
  }
  if (pastedRawText.includes('\0')) {
    return {
      allowed: false,
      normalizedText: '',
      reason: 'NUL bytes cannot be pasted into the text editor.',
    };
  }
  if (hasLoneSurrogate(pastedRawText)) {
    return {
      allowed: false,
      normalizedText: '',
      reason: 'Unpaired UTF-16 surrogates cannot be pasted into the text editor.',
    };
  }
  const normalizedText = normalizePasteToLf(pastedRawText);
  const currentMetrics = calculateEncodedBytes(currentLfText, newline, bom);
  const addedMetrics = calculateEncodedBytes(normalizedText, newline, false);
  const replacedUtf16 = typeof replacedSelectionsOrUtf16 === 'number' ? Math.max(0, replacedSelectionsOrUtf16) : 0;

  // Conservative lower bound when only UTF-16 code unit length is supplied:
  // each replaced UTF-16 BMP/surrogate unit yields >= 1 UTF-8 byte in valid text.
  const resultingLfBytes = Math.max(
    0,
    currentMetrics.lfUtf8Bytes - replacedUtf16 + addedMetrics.lfUtf8Bytes,
  );
  const resultingEncodedBytes =
    currentMetrics.bomBytes +
    resultingLfBytes +
    currentMetrics.crlfExpansionBytes +
    addedMetrics.crlfExpansionBytes;
  if (resultingLfBytes <= MAX_LOCAL_BUFFER_BYTES && resultingEncodedBytes <= MAX_LOCAL_BUFFER_BYTES) {
    return { allowed: true, normalizedText, reason: null };
  }
  return {
    allowed: false,
    normalizedText: '',
    reason: `Paste rejected: resulting content would exceed the ${MAX_LOCAL_BUFFER_BYTES.toLocaleString()} byte local editor ceiling.`,
  };
}
