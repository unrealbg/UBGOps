import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Host } from '@ubgops/protocol';
import { CommandPalette } from './CommandPalette';

const sampleHosts: Host[] = [
  {
    id: 'host-1',
    displayName: 'Gateway Alpha',
    connection: {
      hostname: 'gateway.example.test',
      port: 22,
      username: 'deploy',
      authentication: 'password',
    },
  },
  {
    id: 'host-2',
    displayName: 'Worker Beta',
    connection: {
      hostname: 'worker.example.test',
      port: 2222,
      username: 'ops',
      authentication: 'privateKey',
    },
  },
];

describe('CommandPalette', () => {
  it('filters safe navigation/host actions, supports keyboard selection, and executes on Enter', async () => {
    const onClose = vi.fn();
    const onSelectHost = vi.fn();
    const onSelectSection = vi.fn();

    render(
      <CommandPalette
        open
        onClose={onClose}
        hosts={sampleHosts}
        selectedHost={sampleHosts[0]!}
        activeSection="overview"
        sidebarCollapsed={false}
        terminalFocus={false}
        onSelectHost={onSelectHost}
        onSelectSection={onSelectSection}
        onAddHost={vi.fn()}
        onToggleSidebar={vi.fn()}
        onToggleTerminalFocus={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    const input = within(dialog).getByRole('searchbox', { name: 'Filter commands and hosts' });
    expect(within(dialog).getByText('UI navigation only')).toBeInTheDocument();
    expect(within(dialog).queryByText(/runbook/i)).not.toBeInTheDocument();

    await userEvent.type(input, 'Worker');
    const options = within(dialog).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Worker Beta');

    await userEvent.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelectHost).toHaveBeenCalledWith('host-2');
  });

  it('navigates across options with ArrowDown/ArrowUp and closes on Escape while restoring focus', async () => {
    const onClose = vi.fn();
    const onSelectSection = vi.fn();
    const view = render(
      <>
        <button type="button">Restore Target</button>
        <CommandPalette
          open={false}
          onClose={onClose}
          hosts={sampleHosts}
          selectedHost={sampleHosts[0]!}
          activeSection="overview"
          sidebarCollapsed={false}
          terminalFocus={false}
          onSelectHost={vi.fn()}
          onSelectSection={onSelectSection}
          onAddHost={vi.fn()}
          onToggleSidebar={vi.fn()}
          onToggleTerminalFocus={vi.fn()}
        />
      </>,
    );

    const trigger = screen.getByRole('button', { name: 'Restore Target' });
    trigger.focus();

    view.rerender(
      <>
        <button type="button">Restore Target</button>
        <CommandPalette
          open
          onClose={onClose}
          hosts={sampleHosts}
          selectedHost={sampleHosts[0]!}
          activeSection="overview"
          sidebarCollapsed={false}
          terminalFocus={false}
          onSelectHost={vi.fn()}
          onSelectSection={onSelectSection}
          onAddHost={vi.fn()}
          onToggleSidebar={vi.fn()}
          onToggleTerminalFocus={vi.fn()}
        />
      </>,
    );

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();

    view.rerender(
      <>
        <button type="button">Restore Target</button>
        <CommandPalette
          open={false}
          onClose={onClose}
          hosts={sampleHosts}
          selectedHost={sampleHosts[0]!}
          activeSection="overview"
          sidebarCollapsed={false}
          terminalFocus={false}
          onSelectHost={vi.fn()}
          onSelectSection={onSelectSection}
          onAddHost={vi.fn()}
          onToggleSidebar={vi.fn()}
          onToggleTerminalFocus={vi.fn()}
        />
      </>,
    );
    expect(trigger).toHaveFocus();
  });

  it('disables host-scoped sections when no host is selected', () => {
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        hosts={[]}
        selectedHost={null}
        activeSection="overview"
        sidebarCollapsed={false}
        terminalFocus={false}
        onSelectHost={vi.fn()}
        onSelectSection={vi.fn()}
        onAddHost={vi.fn()}
        onToggleSidebar={vi.fn()}
        onToggleTerminalFocus={vi.fn()}
      />,
    );

    expect(screen.getByRole('option', { name: /Go to Overview/i })).toBeEnabled();
    expect(screen.getByRole('option', { name: /Go to Terminal/i })).toBeDisabled();
    expect(screen.getByRole('option', { name: /Go to Files/i })).toBeDisabled();
    expect(screen.getByRole('option', { name: /Add a host/i })).toBeEnabled();
  });
});
