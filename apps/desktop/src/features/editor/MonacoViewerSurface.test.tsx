import { fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createMock,
  updateOptionsMock,
  triggerMock,
  state,
  setModelLanguageMock,
} = vi.hoisted(() => {
  const state = {
    value: '',
    eol: 0,
    altVersion: 1,
    canUndo: false,
    canRedo: false,
    languageId: 'json',
    keyDownHandlers: [] as Array<(e: unknown) => void>,
    contentHandlers: [] as Array<(e: unknown) => void>,
    selections: [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }],
  };
  return {
    createMock: vi.fn(),
    updateOptionsMock: vi.fn(),
    triggerMock: vi.fn(),
    setModelLanguageMock: vi.fn((_m: unknown, lang: string) => {
      state.languageId = lang;
    }),
    state,
  };
});

vi.mock('./monacoSetup', () => {
  const mockModel = {
    id: 'mock-model',
    setEOL: vi.fn((eol: number) => {
      state.eol = eol;
    }),
    setValue: vi.fn((next: string) => {
      state.value = next;
      state.canUndo = false;
      state.canRedo = false;
      state.altVersion += 1;
    }),
    getValue: vi.fn(() => state.value),
    getLanguageId: vi.fn(() => state.languageId),
    getAlternativeVersionId: vi.fn(() => state.altVersion),
    canUndo: vi.fn(() => state.canUndo),
    canRedo: vi.fn(() => state.canRedo),
    getValueLengthInRange: vi.fn(() => 0),
  };

  let attachedModel: typeof mockModel | null = null;
  const disposable = { dispose: vi.fn() };
  return {
    UBGOPS_MONACO_THEME: 'ubgops-neon-cyan',
    disposeReadOnlyModel: vi.fn(),
    ensureMonacoConfigured: vi.fn(),
    ensureDocumentModel: vi.fn((_id: string, text: string, lang: string) => {
      state.value = text;
      state.languageId = lang;
      return mockModel;
    }),
    ensureReadOnlyModel: vi.fn((_id: string, text: string, lang: string) => {
      state.value = text;
      state.languageId = lang;
      return mockModel;
    }),
    getModelValueLf: vi.fn(() => state.value),
    getModelAlternativeVersionId: vi.fn(() => state.altVersion),
    getModelUndoRedoState: vi.fn(() => ({ canUndo: state.canUndo, canRedo: state.canRedo })),
    resetModelValueLf: vi.fn((_model: unknown, text: string) => {
      state.value = text;
      state.canUndo = false;
      state.canRedo = false;
      state.altVersion += 1;
    }),
    monaco: {
      Uri: {
        parse: vi.fn((raw: string) => ({ toString: () => raw })),
      },
      editor: {
        EndOfLineSequence: { LF: 0, CRLF: 1 },
        EndOfLinePreference: { LF: 1 },
        getModel: vi.fn(() => attachedModel),
        setModelLanguage: setModelLanguageMock,
        create: createMock.mockImplementation(() => ({
          getAction: vi.fn(() => ({ run: vi.fn() })),
          focus: vi.fn(),
          layout: vi.fn(),
          getModel: vi.fn(() => attachedModel),
          setModel: vi.fn((m: typeof mockModel | null) => {
            attachedModel = m;
          }),
          getSelections: vi.fn(() => state.selections),
          saveViewState: vi.fn(() => ({ cursor: 1 })),
          restoreViewState: vi.fn(),
          setScrollTop: vi.fn(),
          setScrollLeft: vi.fn(),
          updateOptions: updateOptionsMock,
          trigger: triggerMock.mockImplementation((_source: string, handlerId: string) => {
            if (handlerId === 'undo') {
              state.canRedo = true;
            }
          }),
          onKeyDown: vi.fn((cb: (e: unknown) => void) => {
            state.keyDownHandlers.push(cb);
            return disposable;
          }),
          onDidChangeModelContent: vi.fn((cb: (e: unknown) => void) => {
            state.contentHandlers.push(cb);
            return disposable;
          }),
          ...disposable,
        })),
      },
    },
  };
});

import MonacoViewerSurface, { type MonacoViewerHandle } from './MonacoViewerSurface';
import { MAX_LOCAL_BUFFER_BYTES, MAX_UNDO_STEPS } from './textCodec';

describe('MonacoViewerSurface options & editable guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.value = '';
    state.eol = 0;
    state.altVersion = 1;
    state.canUndo = false;
    state.canRedo = false;
    state.languageId = 'json';
    state.keyDownHandlers = [];
    state.contentHandlers = [];
  });

  it('enables read-only mode alongside renderValidationDecorations="on"', () => {
    const { rerender } = render(
      <MonacoViewerSurface
        documentId="doc-1"
        text={'{\n  "port": \n}\n'}
        languageId="json"
        fontSize={13}
        wordWrap="off"
        ariaLabel="Read-only preview"
      />,
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    const createOptions = createMock.mock.calls[0]?.[1];
    expect(createOptions).toMatchObject({
      readOnly: true,
      domReadOnly: true,
      renderValidationDecorations: 'on',
      links: false,
    });

    rerender(
      <MonacoViewerSurface
        documentId="doc-1"
        text={'{\n  "port": \n}\n'}
        languageId="json"
        fontSize={15}
        wordWrap="on"
        ariaLabel="Read-only preview"
      />,
    );

    expect(updateOptionsMock).toHaveBeenLastCalledWith({
      readOnly: true,
      domReadOnly: true,
      renderValidationDecorations: 'on',
      fontSize: 15,
      wordWrap: 'on',
      ariaLabel: 'Read-only preview',
    });
  });

  it('enforces capture-phase paste size/NUL gate, KeyS shortcut, undo compaction & handle actions in editable mode', () => {
    const onSaveShortcut = vi.fn();
    const onBufferGuardRejected = vi.fn();
    const onUndoHistoryCompacted = vi.fn();
    const onContentChange = vi.fn();
    const ref = createRef<MonacoViewerHandle>();

    const { getByTestId } = render(
      <MonacoViewerSurface
        viewerRef={ref}
        documentId="doc-edit"
        text="hello\n"
        languageId="plaintext"
        fontSize={13}
        wordWrap="off"
        ariaLabel="Editable host file"
        editable={true}
        newline="lf"
        bom={false}
        onSaveShortcut={onSaveShortcut}
        onBufferGuardRejected={onBufferGuardRejected}
        onUndoHistoryCompacted={onUndoHistoryCompacted}
        onContentChange={onContentChange}
      />,
    );

    expect(createMock.mock.calls[0]?.[1]).toMatchObject({
      readOnly: false,
      domReadOnly: false,
    });

    const container = getByTestId('monaco-viewer-surface');

    // Reject NUL paste in capture phase without insertion
    const nulEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(nulEvent, 'clipboardData', {
      value: { getData: () => 'abc\0def' },
    });
    container.dispatchEvent(nulEvent);
    expect(nulEvent.defaultPrevented).toBe(true);
    expect(onBufferGuardRejected).toHaveBeenCalledWith(expect.stringMatching(/NUL bytes/i));

    // Reject oversized (>1.5 MiB) paste in capture phase without allocation/insertion
    onBufferGuardRejected.mockClear();
    const hugeEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(hugeEvent, 'clipboardData', {
      value: { getData: () => 'x'.repeat(MAX_LOCAL_BUFFER_BYTES + 10) },
    });
    container.dispatchEvent(hugeEvent);
    expect(hugeEvent.defaultPrevented).toBe(true);
    expect(onBufferGuardRejected).toHaveBeenCalledWith(expect.stringMatching(/1,572,864/));

    // Physical KeyS shortcut triggers save regardless of key label (e.g. Cyrillic)
    const prevent = vi.fn();
    const stop = vi.fn();
    state.keyDownHandlers[0]?.({
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      browserEvent: { code: 'KeyS', key: 'с' },
      preventDefault: prevent,
      stopPropagation: stop,
    });
    expect(prevent).toHaveBeenCalledTimes(1);
    expect(onSaveShortcut).toHaveBeenCalledTimes(1);

    // Undo history compaction fires when step count exceeds MAX_UNDO_STEPS while preserving unsaved text
    state.value = 'unsaved-final\n';
    state.canUndo = true;
    for (let i = 0; i <= MAX_UNDO_STEPS; i += 1) {
      state.contentHandlers[0]?.({
        isUndoing: false,
        isRedoing: false,
        changes: [{ text: 'a', rangeLength: 0 }],
      });
    }
    expect(onUndoHistoryCompacted).toHaveBeenCalledTimes(1);
    expect(state.value).toBe('unsaved-final\n');
    expect(state.canUndo).toBe(false);

    // fireEvent click / handle undo/redo checks
    fireEvent.focus(container);
    expect(ref.current?.getValueLf()).toBe('unsaved-final\n');
    state.canUndo = true;
    expect(ref.current?.undo()).toBe(true);
    expect(triggerMock).toHaveBeenCalledWith('ubgops', 'undo', null);
  });
});
