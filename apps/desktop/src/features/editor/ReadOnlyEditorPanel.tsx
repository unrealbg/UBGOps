import { Suspense, lazy, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Notice, Spinner } from '@ubgops/ui';
import type { MonacoViewerHandle } from './MonacoViewerSurface';
import {
  MAX_READONLY_DOCUMENTS,
  type PendingReadOnlyOpen,
  type ReadOnlyDocumentTab,
} from './ReadOnlyEditorRegistry';

const LazyMonacoViewerSurface = lazy(() => import('./MonacoViewerSurface'));

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
}) {
  const [fontSize, setFontSize] = useState(13);
  const [wordWrap, setWordWrap] = useState<'off' | 'on'>('off');
  const viewerRef = useRef<MonacoViewerHandle | null>(null);
  const tabButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    const active = tabs.find((t) => t.id === activeTab?.id);
    if (!active && tabs[0]) {
      onSelectTab(tabs[0].id);
    }
  }, [tabs, activeTab, onSelectTab]);

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

  return (
    <section
      className="readonly-editor-panel"
      aria-label={`Read-only viewer on ${hostDisplayName}`}
      data-testid="readonly-editor-panel"
    >
      <div className="readonly-editor-header">
        <div className="readonly-editor-badges">
          <span className="readonly-badge" data-testid="readonly-status-badge">
            Read-Only
          </span>
          <span className="readonly-count" title="Open read-only documents application-wide">
            {totalOpenCount} / {MAX_READONLY_DOCUMENTS} open
          </span>
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

      {tabs.length > 0 && (
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
                className={`readonly-tab ${selected ? 'is-active' : ''} ${tab.disconnected ? 'is-disconnected' : ''}`}
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
      )}

      {activeTab && (
        <>
          <div className="readonly-meta" data-testid="readonly-document-meta">
            <span className="readonly-meta-path mono" title={activeTab.displayName}>
              {activeTab.displayName}
            </span>
            <span className="readonly-meta-items">
              <span>{activeTab.languageLabel}</span>
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
