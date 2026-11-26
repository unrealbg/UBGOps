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
  exceedsPayloadCap: boolean;
  exceedsLocalBufferCap: boolean;
}

export interface EditableTextValidation {
  canHoldLocally: boolean;
  canSave: boolean;
  reason: string | null;
  metrics: EncodedPayloadMetrics;
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

export function isPasteAllowed(
  currentLfText: string,
  pastedRawText: string,
  replacedLengthUtf16: number,
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
  const normalizedText = normalizePasteToLf(pastedRawText);
  const currentMetrics = calculateEncodedBytes(currentLfText, newline, bom);
  const addedMetrics = calculateEncodedBytes(normalizedText, newline, false);
  // Estimate upper-bound resulting byte size cleanly before applying into Monaco.
  // Conservative lower bound on replaced slice is 0 bytes if replacedLengthUtf16 === 0,
  // or compute exact when replaced slice size is moderate.
  const estimatedBytes =
    currentMetrics.encodedBytes + addedMetrics.lfUtf8Bytes + addedMetrics.crlfExpansionBytes;
  if (estimatedBytes <= MAX_LOCAL_BUFFER_BYTES) {
    return { allowed: true, normalizedText, reason: null };
  }
  // Account accurately for replaced selection when replacing a large range.
  if (replacedLengthUtf16 > 0 && currentLfText.length <= MAX_LOCAL_BUFFER_BYTES) {
    const worstCaseRemainingBytes = currentMetrics.encodedBytes;
    if (worstCaseRemainingBytes - replacedLengthUtf16 + addedMetrics.encodedBytes <= MAX_LOCAL_BUFFER_BYTES) {
      return { allowed: true, normalizedText, reason: null };
    }
  }
  return {
    allowed: false,
    normalizedText: '',
    reason: `Paste rejected: resulting content would exceed the ${MAX_LOCAL_BUFFER_BYTES.toLocaleString()} byte local editor ceiling.`,
  };
}
