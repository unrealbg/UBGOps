import { act, fireEvent, render } from '@testing-library/react';
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
    versionId: 1,
    altVersion: 1,
    canUndo: false,
    canRedo: false,
    disposed: false,
    languageId: 'json',
    nextModelGen: 0,
    undoHistory: [] as string[],
    redoHistory: [] as string[],
    selectedText: [] as string[],
    retainedMeta: new Map<string, {
      modelGeneration: number;
      appliedRevision?: number;
      undoBytes: number;
      undoSteps: number;
      lastValidLf?: string;
      viewState: unknown;
    }>(),
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
  function createMockModel(uriStr: string, initialText: string, lang: string) {
    let modelText = initialText;
    let modelDisposed = false;
    state.value = initialText;
    state.languageId = lang;
    const model = {
      id: `mock-model-${uriStr}`,
      isDisposed: vi.fn(() => modelDisposed),
      dispose: vi.fn(() => {
        modelDisposed = true;
        models.delete(uriStr);
        if (attachedModel === model) attachedModel = null;
      }),
      setEOL: vi.fn((eol: number) => {
        state.eol = eol;
      }),
      setValue: vi.fn((next: string) => {
        modelText = next;
        state.value = next;
        state.canUndo = false;
        state.canRedo = false;
        state.undoHistory = [];
        state.redoHistory = [];
        state.versionId += 1;
        state.altVersion += 1;
      }),
      getValue: vi.fn(() => (attachedModel === model ? state.value : modelText)),
      getLanguageId: vi.fn(() => state.languageId),
      getVersionId: vi.fn(() => state.versionId),
      getAlternativeVersionId: vi.fn(() => state.altVersion),
      canUndo: vi.fn(() => state.canUndo),
      canRedo: vi.fn(() => state.canRedo),
      getFullModelRange: vi.fn(() => ({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 999999,
        endColumn: 999999,
      })),
      pushStackElement: vi.fn(),
      pushEditOperations: vi.fn((_before: unknown, ops: Array<{ text: string }>) => {
        const nextText = ops[0]?.text ?? '';
        state.undoHistory = [state.value];
        state.redoHistory = [];
        modelText = nextText;
        state.value = nextText;
        state.canUndo = true;
        state.canRedo = false;
        state.versionId += 1;
        state.altVersion += 1;
        return null;
      }),
      getValueLengthInRange: vi.fn(() => 0),
      getValueInRange: vi.fn((_sel: unknown) => state.selectedText.shift() ?? ''),
    };
    return model;
  }

  let attachedModel: ReturnType<typeof createMockModel> | null = null;
  const models = new Map<string, ReturnType<typeof createMockModel>>();
  const disposable = { dispose: vi.fn() };
  function getLiveModelById(docId: string) {
    const uri = `ubgops-ro://document/${encodeURIComponent(docId)}`;
    const m = models.get(uri);
    return m && !m.isDisposed() ? m : null;
  }
  return {
    UBGOPS_MONACO_THEME: 'ubgops-neon-cyan',
    hasLiveDocumentModel: vi.fn((docId: string) => getLiveModelById(docId) !== null),
    peekRetainedDocumentMetadata: vi.fn((docId: string) => state.retainedMeta.get(docId)),
    getRetainedMetadataCount: vi.fn(() => state.retainedMeta.size),
    getRetainedModelCount: vi.fn(() => models.size),
    getRetainedDocumentMetadata: vi.fn((docId: string) => {
      let entry = state.retainedMeta.get(docId);
      if (!entry) {
        state.nextModelGen += 1;
        entry = {
          modelGeneration: state.nextModelGen,
          undoBytes: 0,
          undoSteps: 0,
          viewState: null,
        };
        state.retainedMeta.set(docId, entry);
      }
      return entry;
    }),
    saveRetainedViewStateIfLive: vi.fn(
      (
        docId: string,
        expectedModel: unknown,
        expectedModelGeneration: number | null,
        viewState: unknown,
      ) => {
        const live = getLiveModelById(docId);
        const entry = state.retainedMeta.get(docId);
        if (!live || !entry) return false;
        if (expectedModel !== null && live !== expectedModel) return false;
        if (expectedModelGeneration !== null && entry.modelGeneration !== expectedModelGeneration) {
          return false;
        }
        entry.viewState = viewState;
        return true;
      },
    ),
    sanitizeModelUndoWithValidText: vi.fn(
      (model: ReturnType<typeof createMockModel>, preInvalidLf: string, currentValidLf: string) => {
        if (preInvalidLf === currentValidLf) {
          model.setValue(currentValidLf);
          return;
        }
        model.setValue(preInvalidLf);
        model.pushEditOperations([], [{ text: currentValidLf }]);
      },
    ),
    disposeReadOnlyModel: vi.fn((docId: string) => {
      state.retainedMeta.delete(docId);
      const uri = `ubgops-ro://document/${encodeURIComponent(docId)}`;
      const m = models.get(uri);
      if (m) {
        m.dispose();
      }
    }),
    ensureMonacoConfigured: vi.fn(),
    ensureDocumentModel: vi.fn((docId: string, text: string, lang: string) => {
      const uri = `ubgops-ro://document/${encodeURIComponent(docId)}`;
      const existing = models.get(uri);
      if (existing && !existing.isDisposed()) {
        return existing;
      }
      const created = createMockModel(uri, text, lang);
      models.set(uri, created);
      return created;
    }),
    ensureReadOnlyModel: vi.fn((docId: string, text: string, lang: string) => {
      const uri = `ubgops-ro://document/${encodeURIComponent(docId)}`;
      const created = createMockModel(uri, text, lang);
      models.set(uri, created);
      return created;
    }),
    getModelValueLf: vi.fn((m: ReturnType<typeof createMockModel>) => m.getValue()),
    getModelAlternativeVersionId: vi.fn(() => state.altVersion),
    getModelUndoRedoState: vi.fn(() => ({ canUndo: state.canUndo, canRedo: state.canRedo })),
    resetModelValueLf: vi.fn((model: ReturnType<typeof createMockModel>, text: string) => {
      model.setValue(text);
    }),
    monaco: {
      Uri: {
        parse: vi.fn((raw: string) => ({ toString: () => raw })),
      },
      editor: {
        EndOfLineSequence: { LF: 0, CRLF: 1 },
        EndOfLinePreference: { LF: 1 },
        getModel: vi.fn((uri: { toString: () => string }) => models.get(uri.toString()) ?? null),
        setModelLanguage: setModelLanguageMock,
        create: createMock.mockImplementation(() => ({
          getAction: vi.fn(() => ({ run: vi.fn() })),
          focus: vi.fn(),
          layout: vi.fn(),
          getModel: vi.fn(() => attachedModel),
          setModel: vi.fn((m: ReturnType<typeof createMockModel> | null) => {
            attachedModel = m;
            if (m) {
              state.value = m.getValue();
            }
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
import {
  disposeReadOnlyModel,
  getRetainedMetadataCount,
  getRetainedModelCount,
} from './monacoSetup';
import { MAX_LOCAL_BUFFER_BYTES, MAX_UNDO_STEPS } from './textCodec';

describe('MonacoViewerSurface options & editable guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.value = '';
    state.eol = 0;
    state.versionId = 1;
    state.altVersion = 1;
    state.canUndo = false;
    state.canRedo = false;
    state.disposed = false;
    state.languageId = 'json';
    state.undoHistory = [];
    state.redoHistory = [];
    state.selectedText = [];
    state.retainedMeta.clear();
    state.selections = [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }];
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

  it('enforces capture-phase paste size/NUL gate, KeyS shortcut, undo compaction & handle actions in editable mode', async () => {
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

    // Deferred undo history compaction fires outside onDidChangeModelContent while preserving unsaved text
    state.value = 'unsaved-final\n';
    state.canUndo = true;
    for (let i = 0; i <= MAX_UNDO_STEPS; i += 1) {
      state.contentHandlers[0]?.({
        isUndoing: false,
        isRedoing: false,
        changes: [{ text: 'a', rangeLength: 0 }],
      });
    }
    expect(onUndoHistoryCompacted).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onUndoHistoryCompacted).toHaveBeenCalledTimes(1);
    expect(state.value).toBe('unsaved-final\n');
    expect(state.canUndo).toBe(false);

    // Invalid edit (> 1.5 MiB or NUL) reverts cleanly outside onDidChangeModelContent AND clears redo stack
    state.canUndo = true;
    state.canRedo = true;
    state.value = 'invalid\0payload';
    state.contentHandlers[0]?.({
      isUndoing: false,
      isRedoing: false,
      changes: [{ text: 'invalid\0payload', rangeLength: 0 }],
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onBufferGuardRejected).toHaveBeenCalledWith(expect.stringMatching(/NUL bytes/i));
    expect(state.value).toBe('unsaved-final\n');
    expect(state.canRedo).toBe(false);
    expect(ref.current?.redo()).toBe(false);

    // Reject lone surrogate and multi-cursor oversized paste in capture phase
    onBufferGuardRejected.mockClear();
    const loneSurrogatePaste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(loneSurrogatePaste, 'clipboardData', {
      value: { getData: () => 'bad\uD800text' },
    });
    container.dispatchEvent(loneSurrogatePaste);
    expect(loneSurrogatePaste.defaultPrevented).toBe(true);
    expect(onBufferGuardRejected).toHaveBeenCalledWith(expect.stringMatching(/surrogates/i));

    onBufferGuardRejected.mockClear();
    state.selections = [
      { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
    ];
    state.selectedText = ['', ''];
    const multiCursorPaste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(multiCursorPaste, 'clipboardData', {
      value: { getData: () => 'x'.repeat(800_000) },
    });
    container.dispatchEvent(multiCursorPaste);
    expect(multiCursorPaste.defaultPrevented).toBe(true);
    expect(onBufferGuardRejected).toHaveBeenCalledWith(expect.stringMatching(/1,572,864/));

    // fireEvent click / handle undo/redo checks
    fireEvent.focus(container);
    expect(ref.current?.getValueLf()).toBe('unsaved-final\n');
    state.canUndo = true;
    expect(ref.current?.undo()).toBe(true);
    expect(triggerMock).toHaveBeenCalledWith('ubgops', 'undo', null);
  });

  it('preserves unsaved buffer and native undo stack across unmount/remount on the same modelRevision', () => {
    const onContentChange = vi.fn();
    const { unmount } = render(
      <MonacoViewerSurface
        documentId="doc-remount-preserve"
        text="baseline\n"
        languageId="plaintext"
        fontSize={13}
        wordWrap="off"
        ariaLabel="Remount preservation check"
        editable
        modelRevision={1}
        onContentChange={onContentChange}
      />,
    );

    state.value = 'unsaved-draft\n';
    state.canUndo = true;
    state.contentHandlers[0]?.({
      isUndoing: false,
      isRedoing: false,
      changes: [{ text: 'unsaved-draft\n', rangeLength: 9 }],
    });

    const resetCallsBeforeUnmount = vi.mocked(triggerMock).mock.calls.length;
    unmount();

    const remountRef = createRef<MonacoViewerHandle>();
    const remounted = render(
      <MonacoViewerSurface
        documentId="doc-remount-preserve"
        text="baseline\n"
        languageId="plaintext"
        fontSize={13}
        wordWrap="off"
        ariaLabel="Remount preservation check"
        editable
        modelRevision={1}
        viewerRef={remountRef}
      />,
    );

    expect(vi.mocked(triggerMock).mock.calls.length).toBe(resetCallsBeforeUnmount);
    expect(remountRef.current?.getValueLf()).toBe('unsaved-draft\n');
    expect(state.canUndo).toBe(true);
    remounted.unmount();
    disposeReadOnlyModel('doc-remount-preserve');
  });

  it('prevents zombie retained metadata across active close, switch, unmount, and 105 distinct lifecycle cycles (FINDING-03)', async () => {
    const viewA = render(
      <MonacoViewerSurface
        documentId="meta-doc-a"
        text="alpha\n"
        languageId="plaintext"
        fontSize={13}
        wordWrap="off"
        ariaLabel="Metadata A"
        editable
        modelRevision={0}
      />,
    );
    // Dispose models left over from earlier unit tests in this suite so baseline is explicit
    disposeReadOnlyModel('doc-1');
    disposeReadOnlyModel('doc-edit');
    expect(getRetainedMetadataCount()).toBe(1);
    expect(getRetainedModelCount()).toBe(1);

    // 1) Closing active doc-A before switching to doc-B must NOT recreate meta-doc-a
    disposeReadOnlyModel('meta-doc-a');
    expect(getRetainedMetadataCount()).toBe(0);
    viewA.rerender(
      <MonacoViewerSurface
        documentId="meta-doc-b"
        text="beta\n"
        languageId="plaintext"
        fontSize={13}
        wordWrap="off"
        ariaLabel="Metadata B"
        editable
        modelRevision={0}
      />,
    );
    expect(state.retainedMeta.has('meta-doc-a')).toBe(false);
    expect(getRetainedMetadataCount()).toBe(1);

    // 2) Switching away from live doc-B preserves doc-B viewState without leaking
    viewA.rerender(
      <MonacoViewerSurface
        documentId="meta-doc-c"
        text="gamma\n"
        languageId="plaintext"
        fontSize={13}
        wordWrap="off"
        ariaLabel="Metadata C"
        editable
        modelRevision={0}
      />,
    );
    expect(state.retainedMeta.get('meta-doc-b')?.viewState).toEqual({ cursor: 1 });
    expect(getRetainedMetadataCount()).toBe(2);

    // 3) Closing active last tab before unmount must NOT recreate zombie metadata on unmount
    disposeReadOnlyModel('meta-doc-c');
    viewA.unmount();
    expect(state.retainedMeta.has('meta-doc-c')).toBe(false);
    disposeReadOnlyModel('meta-doc-b');
    expect(getRetainedMetadataCount()).toBe(0);
    expect(getRetainedModelCount()).toBe(0);

    // 4) Deferred callbacks after disposal become strict no-ops without recreating metadata
    const onBufferGuardRejected = vi.fn();
    const viewDef = render(
      <MonacoViewerSurface
        documentId="meta-deferred"
        text="init\n"
        languageId="plaintext"
        fontSize={13}
        wordWrap="off"
        ariaLabel="Deferred disposal"
        editable
        modelRevision={0}
        onBufferGuardRejected={onBufferGuardRejected}
      />,
    );
    state.value = 'bad\0text';
    state.versionId += 1;
    state.contentHandlers.at(-1)?.({
      isUndoing: false,
      isRedoing: false,
      changes: [{ text: 'bad\0text', rangeLength: 0 }],
    });
    disposeReadOnlyModel('meta-deferred');
    viewDef.unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(state.retainedMeta.has('meta-deferred')).toBe(false);
    expect(onBufferGuardRejected).not.toHaveBeenCalled();

    // 5) 105 distinct document open/switch/close cycles return models & metadata strictly to 0
    const cycleView = render(
      <MonacoViewerSurface
        documentId="cycle-0"
        text="cycle-0\n"
        languageId="plaintext"
        fontSize={13}
        wordWrap="off"
        ariaLabel="Cycle doc"
        editable
        modelRevision={0}
      />,
    );
    let prevCycleId = 'cycle-0';
    for (let i = 1; i <= 105; i += 1) {
      const nextId = `cycle-${i}`;
      disposeReadOnlyModel(prevCycleId);
      cycleView.rerender(
        <MonacoViewerSurface
          documentId={nextId}
          text={`cycle-${i}\n`}
          languageId="plaintext"
          fontSize={13}
          wordWrap="off"
          ariaLabel="Cycle doc"
          editable
          modelRevision={0}
        />,
      );
      expect(state.retainedMeta.has(prevCycleId)).toBe(false);
      prevCycleId = nextId;
    }
    disposeReadOnlyModel(prevCycleId);
    cycleView.unmount();
    expect(getRetainedMetadataCount()).toBe(0);
    expect(getRetainedModelCount()).toBe(0);
  });

  it('cancels stale deferred invalid-edit revert when synchronous valid edit supersedes it and strips tainted undo (FINDING-04)', async () => {
    const onBufferGuardRejected = vi.fn();
    const onContentChange = vi.fn();
    const view = render(
      <MonacoViewerSurface
        documentId="doc-race"
        text="alpha"
        languageId="plaintext"
        fontSize={13}
        wordWrap="off"
        ariaLabel="Deferred race guard"
        editable
        modelRevision={0}
        onBufferGuardRejected={onBufferGuardRejected}
        onContentChange={onContentChange}
      />,
    );

    const handler = state.contentHandlers.at(-1)!;

    // 1) Invalid edit followed immediately in same event turn by valid edit
    state.value = 'bad\0invalid';
    state.versionId += 1;
    state.canUndo = true;
    handler({ isUndoing: false, isRedoing: false, changes: [{ text: 'bad\0invalid', rangeLength: 5 }] });

    state.value = 'alpha\ngood';
    state.versionId += 1;
    state.canUndo = true;
    handler({ isUndoing: false, isRedoing: false, changes: [{ text: 'alpha\ngood', rangeLength: 11 }] });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(onBufferGuardRejected).not.toHaveBeenCalled();
    expect(state.value).toBe('alpha\ngood');
    expect(state.canUndo).toBe(true);
    expect(state.undoHistory).toEqual(['alpha']);
    expect(state.redoHistory).toEqual([]);

    // 2) Multiple invalid edits in one turn coalesce cleanly and revert once to lastValidLf
    onBufferGuardRejected.mockClear();
    state.value = 'first\0bad';
    state.versionId += 1;
    handler({ isUndoing: false, isRedoing: false, changes: [{ text: 'first\0bad', rangeLength: 10 }] });
    state.value = 'second\0bad';
    state.versionId += 1;
    handler({ isUndoing: false, isRedoing: false, changes: [{ text: 'second\0bad', rangeLength: 9 }] });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onBufferGuardRejected).toHaveBeenCalledTimes(1);
    expect(state.value).toBe('alpha\ngood');
    expect(state.canRedo).toBe(false);

    // 3) Invalid edit followed immediately by Undo back to pre-invalid valid text cancels revert & clears tainted redo
    onBufferGuardRejected.mockClear();
    state.value = 'tainted\0redo';
    state.versionId += 1;
    handler({ isUndoing: false, isRedoing: false, changes: [{ text: 'tainted\0redo', rangeLength: 10 }] });
    state.value = 'alpha\ngood';
    state.versionId += 1;
    state.canRedo = true;
    handler({ isUndoing: true, isRedoing: false, changes: [{ text: 'alpha\ngood', rangeLength: 12 }] });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onBufferGuardRejected).not.toHaveBeenCalled();
    expect(state.value).toBe('alpha\ngood');
    expect(state.canRedo).toBe(false);

    view.unmount();
    disposeReadOnlyModel('doc-race');
  });
});
