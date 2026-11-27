import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { TextNewline } from '@ubgops/protocol';
import {
  UBGOPS_MONACO_THEME,
  disposeReadOnlyModel,
  ensureDocumentModel,
  ensureMonacoConfigured,
  getModelAlternativeVersionId,
  getModelUndoRedoState,
  getModelValueLf,
  getRetainedDocumentMetadata,
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

interface PendingDeferredAction {
  timerId: number;
  documentId: string;
  modelRevision: number | undefined;
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
  const activeDocumentIdRef = useRef<string | null>(null);
  const applyingGuardRef = useRef(false);
  const pendingCompactionRef = useRef<PendingDeferredAction | null>(null);
  const pendingRevertRef = useRef<PendingDeferredAction | null>(null);

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

  const clearPendingDeferredActions = useCallback(() => {
    if (pendingCompactionRef.current !== null) {
      window.clearTimeout(pendingCompactionRef.current.timerId);
      pendingCompactionRef.current = null;
    }
    if (pendingRevertRef.current !== null) {
      window.clearTimeout(pendingRevertRef.current.timerId);
      pendingRevertRef.current = null;
    }
  }, []);

  const compactModelUndoNow = useCallback(
    (
      targetDocId: string,
      expectedRevision: number | undefined,
      reason: string,
    ): boolean => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const meta = getRetainedDocumentMetadata(targetDocId);
      if (
        !editor ||
        !model ||
        activeDocumentIdRef.current !== targetDocId ||
        (expectedRevision !== undefined && meta.appliedRevision !== expectedRevision)
      ) {
        return false;
      }
      const currentText = getModelValueLf(model);
      const savedState = editor.saveViewState();
      applyingGuardRef.current = true;
      try {
        resetModelValueLf(model, currentText);
        if (savedState) {
          editor.restoreViewState(savedState);
        }
        meta.undoBytes = 0;
        meta.undoSteps = 0;
        meta.lastValidLf = currentText;
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
    },
    [],
  );

  const compactActiveModelUndo = useCallback(
    (reason: string): boolean => {
      const activeDocId = activeDocumentIdRef.current;
      if (!activeDocId) return false;
      clearPendingDeferredActions();
      return compactModelUndoNow(activeDocId, undefined, reason);
    },
    [clearPendingDeferredActions, compactModelUndoNow],
  );

  function scheduleDeferredUndoCompaction(
    targetDocId: string,
    targetModel: monaco.editor.ITextModel,
    expectedRevision: number | undefined,
    reason: string,
  ) {
    const existing = pendingCompactionRef.current;
    if (
      existing &&
      existing.documentId === targetDocId &&
      existing.modelRevision === expectedRevision
    ) {
      return;
    }
    if (existing !== null) {
      window.clearTimeout(existing.timerId);
    }
    const timerId = window.setTimeout(() => {
      pendingCompactionRef.current = null;
      const editor = editorRef.current;
      if (!editor || editor.getModel() !== targetModel) return;
      compactModelUndoNow(targetDocId, expectedRevision, reason);
    }, 0);
    pendingCompactionRef.current = {
      timerId,
      documentId: targetDocId,
      modelRevision: expectedRevision,
    };
  }

  function scheduleDeferredInvalidRevert(
    targetDocId: string,
    targetModel: monaco.editor.ITextModel,
    expectedRevision: number | undefined,
    reason: string | null,
  ) {
    if (pendingCompactionRef.current !== null) {
      window.clearTimeout(pendingCompactionRef.current.timerId);
      pendingCompactionRef.current = null;
    }
    const existing = pendingRevertRef.current;
    if (
      existing &&
      existing.documentId === targetDocId &&
      existing.modelRevision === expectedRevision
    ) {
      return;
    }
    if (existing !== null) {
      window.clearTimeout(existing.timerId);
    }
    const timerId = window.setTimeout(() => {
      pendingRevertRef.current = null;
      const editor = editorRef.current;
      const meta = getRetainedDocumentMetadata(targetDocId);
      if (
        !editor ||
        editor.getModel() !== targetModel ||
        activeDocumentIdRef.current !== targetDocId ||
        meta.appliedRevision !== expectedRevision
      ) {
        return;
      }
      const safeText = meta.lastValidLf ?? '';
      const savedState = editor.saveViewState();
      applyingGuardRef.current = true;
      try {
        resetModelValueLf(targetModel, safeText);
        if (savedState) {
          editor.restoreViewState(savedState);
        }
        meta.undoBytes = 0;
        meta.undoSteps = 0;
      } finally {
        applyingGuardRef.current = false;
      }
      if (reason) {
        latestPropsRef.current.onBufferGuardRejected?.(reason);
      }
      latestPropsRef.current.onContentChange?.(
        safeText,
        getModelAlternativeVersionId(targetModel),
        getModelUndoRedoState(targetModel),
      );
    }, 0);
    pendingRevertRef.current = {
      timerId,
      documentId: targetDocId,
      modelRevision: expectedRevision,
    };
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
    [compactActiveModelUndo],
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
      const replacedSelections = selections.map((selection) =>
        model.getValueInRange(selection, monaco.editor.EndOfLinePreference.LF),
      );
      const gate = isPasteAllowed(
        getModelValueLf(model),
        rawPaste,
        replacedSelections,
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

      const meta = getRetainedDocumentMetadata(activeDocId);
      const valueLf = getModelValueLf(model);
      const validation = validateEditableText(valueLf, currentProps.newline, currentProps.bom);
      if (!validation.canHoldLocally) {
        scheduleDeferredInvalidRevert(
          activeDocId,
          model,
          meta.appliedRevision,
          validation.reason,
        );
        return;
      }

      meta.lastValidLf = valueLf;

      if (!event.isUndoing && !event.isRedoing) {
        let deltaBytes = 0;
        for (const change of event.changes) {
          deltaBytes += utf8Encoder.encode(change.text).length + change.rangeLength * 2;
        }
        meta.undoBytes += deltaBytes;
        meta.undoSteps += 1;

        if (meta.undoBytes > MAX_UNDO_HISTORY_BYTES || meta.undoSteps > MAX_UNDO_STEPS) {
          scheduleDeferredUndoCompaction(
            activeDocId,
            model,
            meta.appliedRevision,
            'Undo history exceeded local safety bounds and was compacted while preserving your current buffer.',
          );
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

    return () => {
      clearPendingDeferredActions();
      const currentDocId = activeDocumentIdRef.current;
      if (currentDocId) {
        getRetainedDocumentMetadata(currentDocId).viewState = editor.saveViewState();
      }
      container.removeEventListener('paste', handleCapturePaste, true);
      keyDownDisposable.dispose();
      contentDisposable.dispose();
      observer.disconnect();
      editorRef.current = null;
      activeDocumentIdRef.current = null;
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
      getRetainedDocumentMetadata(previousDocId).viewState = editor.saveViewState();
      clearPendingDeferredActions();
    }

    const existing = monaco.editor.getModel(
      monaco.Uri.parse(`ubgops-ro://document/${encodeURIComponent(documentId)}`),
    );
    const model = existing ?? ensureDocumentModel(documentId, text, languageId);
    const meta = getRetainedDocumentMetadata(documentId);
    const prevRevision = meta.appliedRevision;

    if (!existing) {
      meta.appliedRevision = modelRevision;
      meta.undoBytes = 0;
      meta.undoSteps = 0;
      meta.lastValidLf = text;
    } else if (prevRevision !== modelRevision || (!editable && getModelValueLf(model) !== text)) {
      clearPendingDeferredActions();
      applyingGuardRef.current = true;
      try {
        resetModelValueLf(model, text);
        meta.appliedRevision = modelRevision;
        meta.undoBytes = 0;
        meta.undoSteps = 0;
        meta.lastValidLf = text;
        if (prevRevision !== undefined && prevRevision !== modelRevision) {
          meta.viewState = null;
        }
      } finally {
        applyingGuardRef.current = false;
      }
    } else if (meta.appliedRevision === undefined) {
      meta.appliedRevision = modelRevision;
      if (meta.lastValidLf === undefined) {
        meta.lastValidLf = getModelValueLf(model);
      }
    }

    if (model.getLanguageId() !== languageId) {
      monaco.editor.setModelLanguage(model, languageId);
    }

    if (editor.getModel() !== model) {
      editor.setModel(model);
      if (meta.viewState) {
        editor.restoreViewState(meta.viewState);
      } else {
        editor.setScrollTop(0);
        editor.setScrollLeft(0);
      }
    }
    activeDocumentIdRef.current = documentId;
  }, [documentId, modelRevision, text, languageId, editable, clearPendingDeferredActions]);

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
