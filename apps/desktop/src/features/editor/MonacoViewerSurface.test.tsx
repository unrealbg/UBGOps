import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { createMock, updateOptionsMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateOptionsMock: vi.fn(),
}));

vi.mock('./monacoSetup', () => {
  const disposable = { dispose: vi.fn() };
  return {
    UBGOPS_MONACO_THEME: 'ubgops-neon-cyan',
    disposeReadOnlyModel: vi.fn(),
    ensureMonacoConfigured: vi.fn(),
    ensureReadOnlyModel: vi.fn(() => ({ id: 'mock-model' })),
    monaco: {
      editor: {
        create: createMock.mockImplementation(() => ({
          getAction: vi.fn(() => ({ run: vi.fn() })),
          focus: vi.fn(),
          layout: vi.fn(),
          getModel: vi.fn(() => null),
          setModel: vi.fn(),
          saveViewState: vi.fn(() => null),
          restoreViewState: vi.fn(),
          setScrollTop: vi.fn(),
          setScrollLeft: vi.fn(),
          updateOptions: updateOptionsMock,
          ...disposable,
        })),
      },
    },
  };
});

import MonacoViewerSurface from './MonacoViewerSurface';

describe('MonacoViewerSurface options', () => {
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
});
