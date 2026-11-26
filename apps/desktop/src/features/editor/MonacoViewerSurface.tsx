import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { TextNewline } from '@ubgops/protocol';
import {
  UBGOPS_MONACO_THEME,
  disposeReadOnlyModel,
  ensureDocumentModel,
  ensureMonacoConfigured,
  getModelAlternativeVersionId,
  getModelUndoRedoState,
  getModelValueLf,
  monaco,
  resetModelValueLf,
} from './monacoSetup';
import { registerReadOnlyModelDisposer } from './ReadOnlyEditorRegistry';
import {
  MAX_UNDO_HISTORY_BYTES,
  MAX_UNDO_STEPS,
  isPasteAllowed,
  validateEditableText,
} from './textCodec';

const utf8Encoder = new TextEncoder();

export interface MonacoViewerHandle {
  openFind: () => void;
  focusEditor: () => void;
  undo: () => boolean;
  redo: () => boolean;
  compactUndoHistory: () => boolean;
  getValueLf: () => string | null;
  getAlternativeVersionId: () => number | null;
}

export interface MonacoViewerSurfaceProps {
  documentId: string;
  text: string;
  languageId: string;
  fontSize: number;
  wordWrap: 'off' | 'on';
  ariaLabel: string;
  viewerRef?: Ref<MonacoViewerHandle>;
  editable?: boolean;
  modelRevision?: number;
  newline?: TextNewline;
  bom?: boolean;
  onContentChange?: (
    valueLf: string,
    alternativeVersionId: number,
    undoRedo: { canUndo: boolean; canRedo: boolean },
  ) => void;
  onSaveShortcut?: () => void;
  onBufferGuardRejected?: (reason: string) => void;
  onUndoHistoryCompacted?: (reason: string) => void;
}

export default function MonacoViewerSurface({
  documentId,
  text,
  languageId,
  fontSize,
  wordWrap,
  ariaLabel,
  viewerRef,
  editable = false,
  modelRevision = 0,
  newline = 'lf',
  bom = false,
  onContentChange,
  onSaveShortcut,
  onBufferGuardRejected,
  onUndoHistoryCompacted,
}: MonacoViewerSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStatesRef = useRef<Map<string, monaco.editor.ICodeEditorViewState | null>>(new Map());
  const activeDocumentIdRef = useRef<string | null>(null);
  const appliedRevisionRef = useRef<Map<string, number>>(new Map());
  const undoTrackerRef = useRef<Map<string, { bytes: number; steps: number }>>(new Map());
  const lastValidLfRef = useRef<Map<string, string>>(new Map());
  const applyingGuardRef = useRef(false);

  const latestPropsRef = useRef({
    editable,
    newline,
    bom,
    onContentChange,
    onSaveShortcut,
    onBufferGuardRejected,
    onUndoHistoryCompacted,
  });

  useEffect(() => {
    latestPropsRef.current = {
      editable,
      newline,
      bom,
      onContentChange,
      onSaveShortcut,
      onBufferGuardRejected,
      onUndoHistoryCompacted,
    };
  });

  function compactActiveModelUndo(reason: string): boolean {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const activeDocId = activeDocumentIdRef.current;
    if (!editor || !model || !activeDocId) return false;
    const currentText = getModelValueLf(model);
    const savedState = editor.saveViewState();
    applyingGuardRef.current = true;
    try {
      resetModelValueLf(model, currentText);
      if (savedState) {
        editor.restoreViewState(savedState);
      }
      undoTrackerRef.current.set(activeDocId, { bytes: 0, steps: 0 });
    } finally {
      applyingGuardRef.current = false;
    }
    latestPropsRef.current.onUndoHistoryCompacted?.(reason);
    latestPropsRef.current.onContentChange?.(
      currentText,
      getModelAlternativeVersionId(model),
      getModelUndoRedoState(model),
    );
    return true;
  }

  useImperativeHandle(
    viewerRef,
    () => ({
      openFind: () => {
        void editorRef.current?.getAction('actions.find')?.run();
      },
      focusEditor: () => {
        editorRef.current?.focus();
      },
      undo: () => {
        const editor = editorRef.current;
        if (!editor || !latestPropsRef.current.editable) return false;
        const model = editor.getModel();
        if (!model || !model.canUndo()) return false;
        editor.trigger('ubgops', 'undo', null);
        return true;
      },
      redo: () => {
        const editor = editorRef.current;
        if (!editor || !latestPropsRef.current.editable) return false;
        const model = editor.getModel();
        if (!model || !model.canRedo()) return false;
        editor.trigger('ubgops', 'redo', null);
        return true;
      },
      compactUndoHistory: () => {
        return compactActiveModelUndo(
          'Undo history was compacted explicitly while preserving your current buffer.',
        );
      },
      getValueLf: () => {
        const model = editorRef.current?.getModel();
        return model ? getModelValueLf(model) : null;
      },
      getAlternativeVersionId: () => {
        const model = editorRef.current?.getModel();
        return model ? getModelAlternativeVersionId(model) : null;
      },
    }),
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    ensureMonacoConfigured();
    registerReadOnlyModelDisposer(disposeReadOnlyModel);
    const editor = monaco.editor.create(container, {
      theme: UBGOPS_MONACO_THEME,
      readOnly: !latestPropsRef.current.editable,
      domReadOnly: !latestPropsRef.current.editable,
      renderValidationDecorations: 'on',
      links: false,
      minimap: { enabled: false },
      lineNumbers: 'on',
      folding: true,
      matchBrackets: 'always',
      automaticLayout: false,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      hover: { enabled: 'off' },
      quickSuggestions: false,
      parameterHints: { enabled: false },
      codeLens: false,
      inlayHints: { enabled: 'off' },
      dragAndDrop: false,
      fontSize,
      wordWrap,
      ariaLabel,
    });
    editorRef.current = editor;

    const handleCapturePaste = (event: ClipboardEvent) => {
      const currentProps = latestPropsRef.current;
      if (!currentProps.editable || applyingGuardRef.current) return;
      const model = editor.getModel();
      if (!model) return;
      const rawPaste = event.clipboardData?.getData('text/plain');
      if (rawPaste === undefined) return;
      const selections = editor.getSelections() ?? [];
      let replacedUtf16 = 0;
      for (const selection of selections) {
        replacedUtf16 += model.getValueLengthInRange(selection);
      }
      const gate = isPasteAllowed(
        getModelValueLf(model),
        rawPaste,
        replacedUtf16,
        currentProps.newline,
        currentProps.bom,
      );
      if (!gate.allowed) {
        event.preventDefault();
        event.stopPropagation();
        if (gate.reason) {
          currentProps.onBufferGuardRejected?.(gate.reason);
        }
      }
    };
    container.addEventListener('paste', handleCapturePaste, true);

    const keyDownDisposable = editor.onKeyDown((event) => {
      const currentProps = latestPropsRef.current;
      if (
        currentProps.editable &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.browserEvent.code === 'KeyS'
      ) {
        event.preventDefault();
        event.stopPropagation();
        currentProps.onSaveShortcut?.();
      }
    });

    const contentDisposable = editor.onDidChangeModelContent((event) => {
      const currentProps = latestPropsRef.current;
      if (applyingGuardRef.current || !currentProps.editable) return;
      const model = editor.getModel();
      const activeDocId = activeDocumentIdRef.current;
      if (!model || !activeDocId) return;

      const valueLf = getModelValueLf(model);
      const validation = validateEditableText(valueLf, currentProps.newline, currentProps.bom);
      if (!validation.canHoldLocally) {
        const previousSafe = lastValidLfRef.current.get(activeDocId);
        applyingGuardRef.current = true;
        try {
          if (model.canUndo()) {
            editor.trigger('ubgops-guard', 'undo', null);
          } else if (previousSafe !== undefined && getModelValueLf(model) !== previousSafe) {
            resetModelValueLf(model, previousSafe);
          }
        } finally {
          applyingGuardRef.current = false;
        }
        if (validation.reason) {
          currentProps.onBufferGuardRejected?.(validation.reason);
        }
        return;
      }

      lastValidLfRef.current.set(activeDocId, valueLf);

      if (!event.isUndoing && !event.isRedoing) {
        const tracker = undoTrackerRef.current.get(activeDocId) ?? { bytes: 0, steps: 0 };
        let deltaBytes = 0;
        for (const change of event.changes) {
          deltaBytes += utf8Encoder.encode(change.text).length + change.rangeLength * 2;
        }
        tracker.bytes += deltaBytes;
        tracker.steps += 1;
        undoTrackerRef.current.set(activeDocId, tracker);

        if (tracker.bytes > MAX_UNDO_HISTORY_BYTES || tracker.steps > MAX_UNDO_STEPS) {
          compactActiveModelUndo(
            'Undo history exceeded local safety bounds and was compacted while preserving your current buffer.',
          );
          return;
        }
      }

      currentProps.onContentChange?.(
        valueLf,
        getModelAlternativeVersionId(model),
        getModelUndoRedoState(model),
      );
    });

    const observer = new ResizeObserver(() => {
      editor.layout();
    });
    observer.observe(container);

    const viewStates = viewStatesRef.current;
    const appliedRevisions = appliedRevisionRef.current;
    const undoTrackers = undoTrackerRef.current;
    const lastValids = lastValidLfRef.current;
    return () => {
      container.removeEventListener('paste', handleCapturePaste, true);
      keyDownDisposable.dispose();
      contentDisposable.dispose();
      observer.disconnect();
      editorRef.current = null;
      activeDocumentIdRef.current = null;
      viewStates.clear();
      appliedRevisions.clear();
      undoTrackers.clear();
      lastValids.clear();
      editor.setModel(null);
      editor.dispose();
    };
    // Editor instance is created once on mount; option/document updates flow through dedicated effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const previousDocId = activeDocumentIdRef.current;
    if (previousDocId && previousDocId !== documentId) {
      viewStatesRef.current.set(previousDocId, editor.saveViewState());
    }

    const existing = monaco.editor.getModel(
      monaco.Uri.parse(`ubgops-ro://document/${encodeURIComponent(documentId)}`),
    );
    const model = existing ?? ensureDocumentModel(documentId, text, languageId);
    const prevRevision = appliedRevisionRef.current.get(documentId);

    if (prevRevision !== modelRevision || (!editable && getModelValueLf(model) !== text)) {
      applyingGuardRef.current = true;
      try {
        resetModelValueLf(model, text);
        appliedRevisionRef.current.set(documentId, modelRevision);
        undoTrackerRef.current.set(documentId, { bytes: 0, steps: 0 });
        lastValidLfRef.current.set(documentId, text);
      } finally {
        applyingGuardRef.current = false;
      }
    } else if (prevRevision === undefined) {
      appliedRevisionRef.current.set(documentId, modelRevision);
      if (!lastValidLfRef.current.has(documentId)) {
        lastValidLfRef.current.set(documentId, getModelValueLf(model));
      }
    }

    if (model.getLanguageId() !== languageId) {
      monaco.editor.setModelLanguage(model, languageId);
    }

    if (editor.getModel() !== model) {
      editor.setModel(model);
      const savedViewState = viewStatesRef.current.get(documentId);
      if (savedViewState) {
        editor.restoreViewState(savedViewState);
      } else {
        editor.setScrollTop(0);
        editor.setScrollLeft(0);
      }
    }
    activeDocumentIdRef.current = documentId;
  }, [documentId, modelRevision, text, languageId, editable]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      readOnly: !editable,
      domReadOnly: !editable,
      renderValidationDecorations: 'on',
      fontSize,
      wordWrap,
      ariaLabel,
    });
  }, [editable, fontSize, wordWrap, ariaLabel]);

  return <div ref={containerRef} className="monaco-viewer-surface" data-testid="monaco-viewer-surface" />;
}
