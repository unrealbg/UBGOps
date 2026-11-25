import { Suspense, lazy, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Notice, Spinner } from '@ubgops/ui';
import { Icon } from '../../components/Icon';
import type { MonacoViewerHandle } from './MonacoViewerSurface';
import { SUPPORTED_LANGUAGES } from './languageDetection';
import {
  MAX_READONLY_DOCUMENTS,
  type PendingReadOnlyOpen,
  type ReadOnlyDocumentTab,
} from './ReadOnlyEditorRegistry';

const LazyMonacoViewerSurface = lazy(() => import('./MonacoViewerSurface'));

export type EditorPresentationMode = 'docked' | 'focus';

export interface QuickOpenRemoteFile {
  readonly name: string;
  readonly displayName: string;
  readonly path: string;
  readonly sizeBytes: string | null;
}

function basenameDisplay(displayPath: string): string {
  const trimmed = displayPath.trimEnd();
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
}

export function ReadOnlyEditorPanel({
  hostDisplayName,
  tabs,
  totalOpenCount,
  activeTab,
  pendingOpens,
  error,
  onSelectTab,
  onCloseTab,
  onCloseAllHostTabs,
  onCancelPending,
  onDismissError,
  onBrowseFiles,
  onChangeLanguage,
  focused = false,
  onToggleFocus,
  availableFiles,
  currentDirectoryPath = null,
  canOpenFiles = true,
  onOpenFile,
  activeTransferCount = 0,
  transfersExpanded = false,
  onToggleTransfers,
}: {
  hostDisplayName: string;
  tabs: readonly ReadOnlyDocumentTab[];
  totalOpenCount: number;
  activeTab: ReadOnlyDocumentTab | null;
  pendingOpens: readonly PendingReadOnlyOpen[];
  error: string | null;
  onSelectTab: (documentId: string) => void;
  onCloseTab: (documentId: string) => void;
  onCloseAllHostTabs: () => void;
  onCancelPending: (requestId: string) => void;
  onDismissError: () => void;
  onBrowseFiles: () => void;
  onChangeLanguage?: (documentId: string, languageId: string) => void;
  focused?: boolean;
  onToggleFocus?: () => void;
  availableFiles?: readonly QuickOpenRemoteFile[];
  currentDirectoryPath?: string | null;
  canOpenFiles?: boolean;
  onOpenFile?: (path: string) => void;
  activeTransferCount?: number;
  transfersExpanded?: boolean;
  onToggleTransfers?: () => void;
}) {
  const [fontSize, setFontSize] = useState(13);
  const [wordWrap, setWordWrap] = useState<'off' | 'on'>('off');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState('');
  const viewerRef = useRef<MonacoViewerHandle | null>(null);
  const tabButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const presentationMode: EditorPresentationMode = focused ? 'focus' : 'docked';

  useEffect(() => {
    const active = tabs.find((t) => t.id === activeTab?.id);
    if (!active && tabs[0]) {
      onSelectTab(tabs[0].id);
    }
  }, [tabs, activeTab, onSelectTab]);

  const openPathSet = useMemo(() => {
    const map = new Map<string, ReadOnlyDocumentTab>();
    for (const tab of tabs) {
      if (!tab.disconnected) {
        map.set(tab.path, tab);
      }
    }
    return map;
  }, [tabs]);

  const filteredFiles = useMemo(() => {
    if (!availableFiles) return [];
    const query = pickerFilter.trim().toLocaleLowerCase();
    if (!query) return availableFiles;
    return availableFiles.filter(
      (entry) =>
        entry.displayName.toLocaleLowerCase().includes(query) ||
        entry.path.toLocaleLowerCase().includes(query),
    );
  }, [availableFiles, pickerFilter]);

  function handleTabListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (tabs.length < 2) return;
    const currentIndex = tabs.findIndex((t) => t.id === activeTab?.id);
    if (currentIndex === -1) return;
    let nextIndex = -1;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex >= 0) {
      event.preventDefault();
      const target = tabs[nextIndex]!;
      onSelectTab(target.id);
      tabButtonRefs.current.get(target.id)?.focus();
    }
  }

  function handleAddButtonClick() {
    if (!availableFiles || !onOpenFile) {
      onBrowseFiles();
      return;
    }
    setPickerFilter('');
    setPickerOpen((current) => !current);
  }

  const limitReached = totalOpenCount >= MAX_READONLY_DOCUMENTS;

  return (
    <section
      className={`readonly-editor-panel readonly-editor-panel--${presentationMode}`}
      aria-label={`Read-only viewer on ${hostDisplayName}`}
      data-testid="readonly-editor-panel"
      data-presentation-mode={presentationMode}
    >
      <div className="readonly-editor-header">
        <div className="readonly-editor-badges">
          <span className="readonly-badge" data-testid="readonly-status-badge">
            Read-Only
          </span>
          <span className="readonly-count" title="Open read-only documents application-wide">
            {totalOpenCount} / {MAX_READONLY_DOCUMENTS} open
          </span>
          {focused && (
            <span className="readonly-focus-pill" title={hostDisplayName}>
              {hostDisplayName}
            </span>
          )}
        </div>
        <div className="readonly-editor-controls">
          <Button
            onClick={() => viewerRef.current?.openFind()}
            disabled={!activeTab}
            title="Search within document (Ctrl+F)"
          >
            Find
          </Button>
          <Button
            aria-pressed={wordWrap === 'on'}
            onClick={() => setWordWrap((current) => (current === 'off' ? 'on' : 'off'))}
            disabled={!activeTab}
          >
            Wrap: {wordWrap === 'on' ? 'On' : 'Off'}
          </Button>
          <div className="readonly-font-controls" role="group" aria-label="Editor font size">
            <Button
              onClick={() => setFontSize((size) => Math.max(11, size - 1))}
              disabled={!activeTab || fontSize <= 11}
              aria-label="Decrease font size"
            >
              A-
            </Button>
            <span className="readonly-font-value">{fontSize}px</span>
            <Button
              onClick={() => setFontSize((size) => Math.min(20, size + 1))}
              disabled={!activeTab || fontSize >= 20}
              aria-label="Increase font size"
            >
              A+
            </Button>
          </div>
          {onToggleFocus && (
            <Button
              variant="ghost"
              aria-pressed={focused}
              title={focused ? 'Exit editor focus mode' : 'Focus editor workspace'}
              onClick={onToggleFocus}
            >
              <Icon name={focused ? 'minimize' : 'maximize'} size={14} />
              {focused ? 'Exit focus' : 'Focus'}
            </Button>
          )}
          {focused && activeTransferCount > 0 && onToggleTransfers && (
            <Button variant="ghost" aria-pressed={transfersExpanded} onClick={onToggleTransfers}>
              Transfers ({activeTransferCount})
            </Button>
          )}
          <Button onClick={onBrowseFiles}>Browse files</Button>
          {tabs.length > 1 && (
            <Button variant="ghost" onClick={onCloseAllHostTabs}>
              Close all
            </Button>
          )}
        </div>
      </div>

      {error && (
        <Notice>
          {error}
          <div className="notice-action">
            <Button onClick={onDismissError}>Dismiss</Button>
          </div>
        </Notice>
      )}

      {pendingOpens.length > 0 && (
        <div className="readonly-pending-bar" role="status">
          {pendingOpens.map((item) => (
            <div className="readonly-pending-item" key={item.requestId}>
              <Spinner label={`Loading ${basenameDisplay(item.path)}…`} />
              <Button onClick={() => onCancelPending(item.requestId)}>Cancel load</Button>
            </div>
          ))}
        </div>
      )}

      {(tabs.length > 0 || availableFiles !== undefined) && (
        <div className="readonly-tabs-bar">
          <div
            className="readonly-tabs"
            role="tablist"
            aria-label="Open read-only documents"
            onKeyDown={handleTabListKeyDown}
          >
            {tabs.map((tab) => {
              const selected = tab.id === activeTab?.id;
              const label = basenameDisplay(tab.displayName);
              return (
                <div
                  key={tab.id}
                  className={`readonly-tab ${selected ? 'is-active' : 'is-inactive'} ${tab.disconnected ? 'is-disconnected' : ''}`}
                >
                  <button
                    ref={(el) => {
                      if (el) tabButtonRefs.current.set(tab.id, el);
                      else tabButtonRefs.current.delete(tab.id);
                    }}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className="readonly-tab-trigger"
                    title={tab.displayName}
                    onClick={() => onSelectTab(tab.id)}
                  >
                    <span className="readonly-tab-name">{label}</span>
                    <span className="readonly-tab-lang">{tab.languageLabel}</span>
                    {tab.disconnected && (
                      <span className="readonly-tab-stale" title="Disconnected read-only snapshot">
                        Offline
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="readonly-tab-close"
                    aria-label={`Close ${label}`}
                    title={`Close ${label}`}
                    onClick={() => onCloseTab(tab.id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="readonly-tab-add"
            aria-label="Open another remote file"
            aria-expanded={availableFiles ? pickerOpen : undefined}
            title="Open another remote file (+)"
            disabled={availableFiles !== undefined && !canOpenFiles}
            onClick={handleAddButtonClick}
          >
            +
          </button>
        </div>
      )}

      {pickerOpen && availableFiles && onOpenFile && (
        <div
          className="readonly-quick-open"
          role="region"
          aria-label="Open another remote file"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setPickerOpen(false);
            }
          }}
        >
          <div className="readonly-quick-open-bar">
            <span className="readonly-quick-open-title">
              Files in <code className="mono">{currentDirectoryPath ?? 'current directory'}</code>
            </span>
            <input
              type="search"
              className="readonly-quick-open-filter"
              aria-label="Filter files in current directory"
              placeholder="Filter current directory files…"
              value={pickerFilter}
              autoFocus
              onChange={(event) => setPickerFilter(event.target.value)}
            />
            <Button
              onClick={() => {
                setPickerOpen(false);
                onBrowseFiles();
              }}
            >
              Browse directories…
            </Button>
            <Button variant="ghost" onClick={() => setPickerOpen(false)}>
              Close
            </Button>
          </div>
          {limitReached && (
            <div className="readonly-quick-open-hint" role="status">
              Document limit reached ({MAX_READONLY_DOCUMENTS} / {MAX_READONLY_DOCUMENTS} open). Selecting an already open tab switches to it; close a tab to open a new file.
            </div>
          )}
          <div className="readonly-quick-open-list">
            {filteredFiles.length === 0 ? (
              <div className="readonly-quick-open-empty">
                No matching regular files in this directory. Use Browse directories… to navigate elsewhere.
              </div>
            ) : (
              filteredFiles.map((file) => {
                const alreadyOpen = openPathSet.get(file.path);
                return (
                  <button
                    key={file.path}
                    type="button"
                    className={`readonly-quick-open-item ${alreadyOpen ? 'is-open' : ''}`}
                    title={file.displayName}
                    disabled={!alreadyOpen && limitReached}
                    onClick={() => {
                      if (alreadyOpen) {
                        onSelectTab(alreadyOpen.id);
                      } else {
                        onOpenFile(file.path);
                      }
                      setPickerOpen(false);
                    }}
                  >
                    <span className="readonly-quick-open-name">{file.displayName}</span>
                    <span className="readonly-quick-open-meta">
                      {alreadyOpen
                        ? 'Already open'
                        : file.sizeBytes !== null
                          ? `${file.sizeBytes} B`
                          : 'file'}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      {activeTab && (
        <>
          <div className="readonly-meta" data-testid="readonly-document-meta">
            <span className="readonly-meta-path mono" title={activeTab.displayName}>
              {activeTab.displayName}
            </span>
            <span className="readonly-meta-items">
              {onChangeLanguage ? (
                <label className="readonly-lang-label">
                  <span className="sr-only">Language mode</span>
                  <select
                    className="readonly-lang-select"
                    aria-label="Language mode"
                    value={activeTab.languageId}
                    onChange={(event) => onChangeLanguage(activeTab.id, event.target.value)}
                  >
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <option key={lang.id} value={lang.id}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span>{activeTab.languageLabel}</span>
              )}
              <span>·</span>
              <span>UTF-8{activeTab.bom ? ' (BOM)' : ''}</span>
              <span>·</span>
              <span>{activeTab.newline === 'crLf' ? 'CRLF' : 'LF'}</span>
              <span>·</span>
              <span>{activeTab.originalBytes} B</span>
              {activeTab.permissions && (
                <>
                  <span>·</span>
                  <span>{activeTab.permissions}</span>
                </>
              )}
            </span>
          </div>
          {activeTab.disconnected && (
            <Notice>
              Disconnected read-only snapshot. Reconnect and reopen the file from Files to refresh its contents.
            </Notice>
          )}
          <div className="readonly-viewer-frame">
            <Suspense fallback={<Spinner label="Loading Monaco viewer…" />}>
              <LazyMonacoViewerSurface
                documentId={activeTab.id}
                text={activeTab.text}
                languageId={activeTab.languageId}
                fontSize={fontSize}
                wordWrap={wordWrap}
                ariaLabel={`Read-only view of ${basenameDisplay(activeTab.displayName)}`}
                viewerRef={viewerRef}
              />
            </Suspense>
          </div>
        </>
      )}
    </section>
  );
}
