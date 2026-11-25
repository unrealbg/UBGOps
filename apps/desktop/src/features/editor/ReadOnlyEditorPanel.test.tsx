import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteReadOnlyDocument, SftpSessionInfo } from '@ubgops/protocol';
import { filesApi } from '../../api/client';
import {
  MAX_READONLY_DOCUMENTS,
  ReadOnlyEditorProvider,
  registerReadOnlyModelDisposer,
  useReadOnlyEditor,
} from './ReadOnlyEditorRegistry';
import { ReadOnlyEditorPanel } from './ReadOnlyEditorPanel';

vi.mock('./MonacoViewerSurface', () => ({
  default: ({
    documentId,
    text,
    languageId,
    fontSize,
    wordWrap,
    ariaLabel,
  }: {
    documentId: string;
    text: string;
    languageId: string;
    fontSize: number;
    wordWrap: 'off' | 'on';
    ariaLabel: string;
  }) => (
    <div
      data-testid="mock-monaco-surface"
      data-doc-id={documentId}
      data-language={languageId}
      data-font-size={fontSize}
      data-word-wrap={wordWrap}
      aria-label={ariaLabel}
    >
      <textarea readOnly aria-label={ariaLabel} value={text} />
    </div>
  ),
}));

vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  filesApi: {
    openReadOnly: vi.fn(),
    cancelReadOnlyOpen: vi.fn(),
  },
}));

function makeSession(hostId: string, hostSessionId: string, sftpId: string): SftpSessionInfo {
  return {
    id: sftpId,
    hostId,
    hostSessionId,
    protocolVersion: 3,
    extensions: [],
    limits: {
      maxPacketBytes: '262144',
      maxReadBytes: '65536',
      maxWriteBytes: '65536',
      maxOpenHandles: '64',
      clientChunkBytes: '65536',
      listingEntryCap: 5000,
    },
    rootPath: '/etc',
  };
}

function Harness({ hostId }: { hostId: string }) {
  const registry = useReadOnlyEditor();
  const hostTabs = registry.documents.filter((doc) => doc.hostId === hostId);
  const activeTab =
    hostTabs.find((doc) => doc.id === registry.activeByHost[hostId]) ?? hostTabs[0] ?? null;

  return (
    <div>
      <button
        type="button"
        onClick={() => void registry.openDocument(makeSession(hostId, `sess-${hostId}`, `sftp-${hostId}`), '/etc/shared.conf')}
      >
        Open shared on {hostId}
      </button>
      <button
        type="button"
        onClick={() => {
          for (let i = 0; i < MAX_READONLY_DOCUMENTS + 1; i += 1) {
            void registry.openDocument(
              makeSession(hostId, `sess-${hostId}`, `sftp-${hostId}`),
              `/etc/file-${i}.toml`,
            );
          }
        }}
      >
        Open 9 on {hostId}
      </button>
      <button type="button" onClick={() => registry.purgeHost('host-b')}>
        Purge host-b
      </button>
      <button
        type="button"
        onClick={() => registry.syncHostConnection(hostId, false, null, null)}
      >
        Disconnect {hostId}
      </button>
      <ReadOnlyEditorPanel
        hostDisplayName={hostId}
        tabs={hostTabs}
        totalOpenCount={registry.documents.length}
        activeTab={activeTab}
        pendingOpens={registry.pendingOpens.filter((item) => item.hostId === hostId)}
        error={registry.errorsByHost[hostId] ?? null}
        onSelectTab={(id) => registry.selectDocument(hostId, id)}
        onCloseTab={(id) => registry.closeDocument(id)}
        onCloseAllHostTabs={() => registry.closeHostDocuments(hostId)}
        onCancelPending={(id) => void registry.cancelOpen(hostId, id)}
        onDismissError={() => registry.clearHostError(hostId)}
        onBrowseFiles={vi.fn()}
      />
    </div>
  );
}

describe('ReadOnlyEditorRegistry and ReadOnlyEditorPanel', () => {
  let seq = 0;
  const disposer = vi.fn();

  beforeEach(() => {
    seq = 0;
    disposer.mockReset();
    registerReadOnlyModelDisposer(disposer);
    vi.mocked(filesApi.cancelReadOnlyOpen).mockResolvedValue(true);
    vi.mocked(filesApi.openReadOnly).mockImplementation(
      async (session, _reqId, path): Promise<RemoteReadOnlyDocument> => {
        seq += 1;
        return {
          id: `opaque-doc-${seq}`,
          hostId: session.hostId,
          hostSessionId: session.hostSessionId,
          sftpSessionId: session.id,
          path,
          displayName: path,
          text: `[config]\nhost="${session.hostId}"\npath="${path}"\n`,
          originalBytes: 42,
          newline: path.endsWith('.toml') ? 'lf' : 'crLf',
          bom: path.endsWith('.conf'),
          maxBytes: 1_048_576,
          modifiedAt: null,
          permissions: '-rw-r--r--',
        };
      },
    );
  });

  it('isolates identical remote paths across hosts, enforces 8-doc app limit across hidden hosts, disposes models, and marks disconnect without silent rebind', async () => {
    const view = render(
      <ReadOnlyEditorProvider>
        <Harness hostId="host-a" />
      </ReadOnlyEditorProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open shared on host-a' }));
    const surfaceA = await screen.findByTestId('mock-monaco-surface');
    expect(surfaceA).toHaveAttribute('data-doc-id', 'opaque-doc-1');
    expect(screen.getByTestId('readonly-status-badge')).toHaveTextContent('Read-Only');
    expect(screen.getByTestId('readonly-document-meta')).toHaveTextContent('UTF-8 (BOM)');
    expect(screen.getByTestId('readonly-document-meta')).toHaveTextContent('CRLF');

    // Configurable font size and word wrap work strictly in read-only mode.
    await userEvent.click(screen.getByRole('button', { name: 'Increase font size' }));
    await userEvent.click(screen.getByRole('button', { name: 'Wrap: Off' }));
    expect(surfaceA).toHaveAttribute('data-font-size', '14');
    expect(surfaceA).toHaveAttribute('data-word-wrap', 'on');

    // Switch active view to host-b inside the same provider: host-a tab never leaks into host-b, and unmount disposes opaque-doc-1.
    view.rerender(
      <ReadOnlyEditorProvider>
        <Harness hostId="host-b" />
      </ReadOnlyEditorProvider>,
    );
    expect(screen.queryByTestId('mock-monaco-surface')).not.toBeInTheDocument();
    view.unmount();
    expect(disposer).toHaveBeenCalledWith('opaque-doc-1');
  });

  it('enforces the 8-document application-wide limit across visible and hidden hosts', async () => {
    function MultiHostHarness() {
      const [activeHost, setActiveHost] = useState('host-a');
      return (
        <div>
          <button type="button" onClick={() => setActiveHost('host-b')}>Switch host-b</button>
          <button type="button" onClick={() => setActiveHost('host-a')}>Switch host-a</button>
          <Harness hostId={activeHost} />
        </div>
      );
    }
    const { useState } = await import('react');
    render(
      <ReadOnlyEditorProvider>
        <MultiHostHarness />
      </ReadOnlyEditorProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open shared on host-a' }));
    await screen.findByTestId('mock-monaco-surface');

    // Switch to host-b (host-a stays retained hidden with 1 doc). Try to open 9 files on host-b.
    await userEvent.click(screen.getByRole('button', { name: 'Switch host-b' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open 9 on host-b' }));
    await waitFor(() => expect(screen.getByText('8 / 8 open')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Document limit reached (8');

    // Opening identical path on host-b got distinct opaque ID from host-a.
    await userEvent.click(screen.getByRole('button', { name: 'Purge host-b' }));
    expect(disposer).toHaveBeenCalledTimes(7);

    // Switch back to host-a and disconnect: marked offline and never exposes Save/Edit actions.
    await userEvent.click(screen.getByRole('button', { name: 'Switch host-a' }));
    expect(screen.getByText('1 / 8 open')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect host-a' }));
    expect(screen.getByText(/Disconnected read-only snapshot/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/i })).not.toBeInTheDocument();
    expect(within(screen.getByRole('tablist')).getByText('Offline')).toBeInTheDocument();
  });

  it('cancels in-flight open and ignores stale late response', async () => {
    let resolveDelayed!: (value: RemoteReadOnlyDocument) => void;
    vi.mocked(filesApi.openReadOnly).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDelayed = resolve;
      }),
    );

    render(
      <ReadOnlyEditorProvider>
        <Harness hostId="host-a" />
      </ReadOnlyEditorProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open shared on host-a' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel load' }));
    expect(filesApi.cancelReadOnlyOpen).toHaveBeenCalledOnce();

    await act(async () => {
      resolveDelayed({
        id: 'late-doc',
        hostId: 'host-a',
        hostSessionId: 'sess-host-a',
        sftpSessionId: 'sftp-host-a',
        path: '/etc/shared.conf',
        displayName: '/etc/shared.conf',
        text: 'late',
        originalBytes: 4,
        newline: 'lf',
        bom: false,
        maxBytes: 1_048_576,
        modifiedAt: null,
        permissions: null,
      });
    });

    expect(screen.queryByTestId('mock-monaco-surface')).not.toBeInTheDocument();
  });
});
