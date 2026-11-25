import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import {
  UBGOPS_MONACO_THEME,
  disposeReadOnlyModel,
  ensureMonacoConfigured,
  ensureReadOnlyModel,
  monaco,
} from './monacoSetup';
import { registerReadOnlyModelDisposer } from './ReadOnlyEditorRegistry';

export interface MonacoViewerHandle {
  openFind: () => void;
  focusEditor: () => void;
}

export interface MonacoViewerSurfaceProps {
  documentId: string;
  text: string;
  languageId: string;
  fontSize: number;
  wordWrap: 'off' | 'on';
  ariaLabel: string;
  viewerRef?: Ref<MonacoViewerHandle>;
}

export default function MonacoViewerSurface({
  documentId,
  text,
  languageId,
  fontSize,
  wordWrap,
  ariaLabel,
  viewerRef,
}: MonacoViewerSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStatesRef = useRef<Map<string, monaco.editor.ICodeEditorViewState | null>>(new Map());
  const activeDocumentIdRef = useRef<string | null>(null);

  useImperativeHandle(
    viewerRef,
    () => ({
      openFind: () => {
        void editorRef.current?.getAction('actions.find')?.run();
      },
      focusEditor: () => {
        editorRef.current?.focus();
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
      readOnly: true,
      domReadOnly: true,
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

    const observer = new ResizeObserver(() => {
      editor.layout();
    });
    observer.observe(container);

    const viewStates = viewStatesRef.current;
    return () => {
      observer.disconnect();
      editorRef.current = null;
      activeDocumentIdRef.current = null;
      viewStates.clear();
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

    const model = ensureReadOnlyModel(documentId, text, languageId);
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
  }, [documentId, text, languageId]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      readOnly: true,
      domReadOnly: true,
      fontSize,
      wordWrap,
      ariaLabel,
    });
  }, [fontSize, wordWrap, ariaLabel]);

  return <div ref={containerRef} className="monaco-viewer-surface" data-testid="monaco-viewer-surface" />;
}
