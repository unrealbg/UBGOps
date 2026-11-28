// Lazy local-only Monaco Editor initialization for UBGOps read-only viewing.
// Zero CDN requests, zero external LSP/extensions, zero hover Markdown UI.
import '@ubgops/monaco-codicon.css';
import '@ubgops/monaco-codicon-modifiers.css';
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget';
import 'monaco-editor/editor/browser/coreCommands';
import 'monaco-editor/editor/common/services/treeViewsDndService';
import 'monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/codelens/browser/codeLensCache';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/features/find/register';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/fontZoom/browser/fontZoom';
import 'monaco-editor/editor/contrib/indentation/browser/indentation';
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsController';
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor';
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution';
import 'monaco-editor/editor/contrib/suggest/browser/suggestMemory';
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode';
import 'monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter';
import 'monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';

// Curated infrastructure & systems Monarch grammars (no TS/CSS/HTML language-server workers)
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/dockerfile/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/hcl/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/ini/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/php/register';
import 'monaco-editor/languages/definitions/powershell/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/yaml/register';

import * as jsonFeature from 'monaco-editor/languages/features/json/register';
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import { registerCustomInfraLanguages } from './customGrammars';
import { registerTomlLanguage } from './tomlGrammar';

export const UBGOPS_MONACO_THEME = 'ubgops-neon-cyan';
export const READONLY_MODEL_SCHEME = 'ubgops-ro';

interface MonacoEnvironmentScope {
  MonacoEnvironment?: {
    getWorker: (moduleId: string, label: string) => Worker;
  };
}

let initialized = false;

export function ensureMonacoConfigured(): void {
  if (initialized) return;
  initialized = true;

  const workerScope = self as unknown as MonacoEnvironmentScope;
  workerScope.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      if (label === 'json') {
        return new JsonWorker();
      }
      return new EditorWorker();
    },
  };

  registerTomlLanguage(monaco);
  registerCustomInfraLanguages(monaco);

  // Strictly offline JSON worker: allow local syntax diagnostics/folding/selection only;
  // disable external schema fetches and Markdown hover/completion UI.
  jsonFeature.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    schemas: [],
    enableSchemaRequest: false,
  });
  jsonFeature.jsonDefaults.setModeConfiguration({
    tokens: true,
    diagnostics: true,
    foldingRanges: true,
    selectionRanges: true,
    hovers: false,
    completionItems: false,
    documentFormattingEdits: false,
    documentRangeFormattingEdits: false,
    documentSymbols: false,
    colors: false,
  });

  monaco.editor.defineTheme(UBGOPS_MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '829AB5', fontStyle: 'italic' },
      { token: 'keyword', foreground: '22D3EE' },
      { token: 'string', foreground: '35D994' },
      { token: 'string.value.json', foreground: '35D994' },
      { token: 'string.key.json', foreground: 'E9F1FB' },
      { token: 'number', foreground: 'FCD34D' },
      { token: 'type', foreground: '249CF3' },
      { token: 'type.identifier', foreground: '249CF3' },
      { token: 'tag', foreground: '22D3EE' },
      { token: 'metatag', foreground: '22D3EE' },
      { token: 'attribute.name', foreground: '93C5FD' },
      { token: 'attribute.value', foreground: '35D994' },
      { token: 'variable', foreground: 'F59E0B' },
      { token: 'key', foreground: 'E9F1FB' },
      { token: 'delimiter', foreground: 'A1B6CE' },
    ],
    colors: {
      'editor.background': '#060c17',
      'editor.foreground': '#e9f1fb',
      'editorLineNumber.foreground': '#829ab5',
      'editorLineNumber.activeForeground': '#22d3ee',
      'editorCursor.foreground': '#22d3ee',
      'editor.selectionBackground': '#22d3ee2e',
      'editor.lineHighlightBackground': '#10203366',
      'editorWidget.background': '#0b1526',
      'editorWidget.border': '#2a4661',
      'input.background': '#080f1c',
      'input.border': '#2a4661',
      focusBorder: '#22d3ee',
    },
  });
}

export function opaqueReadOnlyModelUri(documentId: string): monaco.Uri {
  return monaco.Uri.parse(`${READONLY_MODEL_SCHEME}://document/${encodeURIComponent(documentId)}`);
}

export function getModelValueLf(model: monaco.editor.ITextModel): string {
  return model.getValue(monaco.editor.EndOfLinePreference.LF);
}

export function getModelAlternativeVersionId(model: monaco.editor.ITextModel): number {
  return model.getAlternativeVersionId();
}

export function getModelUndoRedoState(model: monaco.editor.ITextModel): {
  canUndo: boolean;
  canRedo: boolean;
} {
  return {
    canUndo: model.canUndo(),
    canRedo: model.canRedo(),
  };
}

export function ensureDocumentModel(
  documentId: string,
  text: string,
  languageId: string,
): monaco.editor.ITextModel {
  ensureMonacoConfigured();
  const uri = opaqueReadOnlyModelUri(documentId);
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    existing.setEOL(monaco.editor.EndOfLineSequence.LF);
    if (getModelValueLf(existing) !== text) {
      existing.setValue(text);
    }
    if (existing.getLanguageId() !== languageId) {
      monaco.editor.setModelLanguage(existing, languageId);
    }
    return existing;
  }
  const created = monaco.editor.createModel(text, languageId, uri);
  created.setEOL(monaco.editor.EndOfLineSequence.LF);
  return created;
}

export function resetModelValueLf(
  model: monaco.editor.ITextModel,
  text: string,
): void {
  model.setEOL(monaco.editor.EndOfLineSequence.LF);
  model.setValue(text);
}

export function ensureReadOnlyModel(
  documentId: string,
  text: string,
  languageId: string,
): monaco.editor.ITextModel {
  return ensureDocumentModel(documentId, text, languageId);
}

export interface RetainedDocumentMetadata {
  modelGeneration: number;
  appliedRevision?: number;
  undoBytes: number;
  undoSteps: number;
  lastValidLf?: string;
  viewState: monaco.editor.ICodeEditorViewState | null;
}

let nextModelGeneration = 0;
const retainedDocumentMetadata = new Map<string, RetainedDocumentMetadata>();

function nextGenerationId(): number {
  nextModelGeneration += 1;
  return nextModelGeneration;
}

function getLiveModelById(documentId: string): monaco.editor.ITextModel | null {
  const model = monaco.editor.getModel(opaqueReadOnlyModelUri(documentId));
  if (!model) return null;
  if (typeof (model as { isDisposed?: () => boolean }).isDisposed === 'function' && (model as { isDisposed: () => boolean }).isDisposed()) {
    return null;
  }
  return model;
}

export function hasLiveDocumentModel(documentId: string): boolean {
  return getLiveModelById(documentId) !== null;
}

export function peekRetainedDocumentMetadata(documentId: string): RetainedDocumentMetadata | undefined {
  return retainedDocumentMetadata.get(documentId);
}

export function getRetainedMetadataCount(): number {
  return retainedDocumentMetadata.size;
}

export function getRetainedDocumentMetadata(documentId: string): RetainedDocumentMetadata {
  let entry = retainedDocumentMetadata.get(documentId);
  if (!entry) {
    entry = { modelGeneration: nextGenerationId(), undoBytes: 0, undoSteps: 0, viewState: null };
    retainedDocumentMetadata.set(documentId, entry);
  }
  return entry;
}

export function saveRetainedViewStateIfLive(
  documentId: string,
  expectedModel: monaco.editor.ITextModel | null,
  expectedModelGeneration: number | null,
  viewState: monaco.editor.ICodeEditorViewState | null,
): boolean {
  const liveModel = getLiveModelById(documentId);
  const entry = retainedDocumentMetadata.get(documentId);
  if (!liveModel || !entry) {
    return false;
  }
  if (expectedModel !== null && liveModel !== expectedModel) {
    return false;
  }
  if (expectedModelGeneration !== null && entry.modelGeneration !== expectedModelGeneration) {
    return false;
  }
  entry.viewState = viewState;
  return true;
}

export function sanitizeModelUndoWithValidText(
  model: monaco.editor.ITextModel,
  preInvalidLf: string,
  currentValidLf: string,
): void {
  if (preInvalidLf === currentValidLf) {
    resetModelValueLf(model, currentValidLf);
    return;
  }
  const fullRange =
    typeof (model as { getFullModelRange?: () => monaco.IRange }).getFullModelRange === 'function'
      ? (model as { getFullModelRange: () => monaco.IRange }).getFullModelRange()
      : null;
  if (fullRange && typeof model.pushEditOperations === 'function') {
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    model.setValue(preInvalidLf);
    model.pushStackElement?.();
    model.pushEditOperations([], [{ range: fullRange, text: currentValidLf }], () => null);
    model.pushStackElement?.();
    return;
  }
  resetModelValueLf(model, currentValidLf);
}

export function disposeReadOnlyModel(documentId: string): void {
  retainedDocumentMetadata.delete(documentId);
  const uri = opaqueReadOnlyModelUri(documentId);
  const model = monaco.editor.getModel(uri);
  if (model && !(typeof (model as { isDisposed?: () => boolean }).isDisposed === 'function' && (model as { isDisposed: () => boolean }).isDisposed())) {
    model.dispose();
  }
}

export function getRetainedModelCount(): number {
  return monaco.editor.getModels().length;
}

export { monaco };
