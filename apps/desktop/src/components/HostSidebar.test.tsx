import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Host } from '@ubgops/protocol';
import { describe, expect, it, vi } from 'vitest';
import { applicationVersion } from '../applicationVersion';
import hostSidebarSource from './HostSidebar.tsx?raw';
import ubgopsSvgSource from '../../public/ubgops.svg?raw';
import { HostSidebar } from './HostSidebar';

vi.mock('../api/queries', () => ({ useHostSession: vi.fn(() => ({ data: undefined })) }));

const sampleHosts: Host[] = [
  {
    id: 'h1',
    displayName: 'Gateway Alpha',
    connection: {
      hostname: 'gateway.example.test',
      port: 22,
      username: 'deploy',
      authentication: 'password',
    },
  },
  {
    id: 'h2',
    displayName: 'Worker Beta',
    connection: {
      hostname: 'worker.example.test',
      port: 2222,
      username: 'ops',
      authentication: 'privateKey',
    },
  },
];

function renderSidebar(applicationVersion?: string) {
  render(
    <HostSidebar
      hosts={[]}
      selectedId={null}
      onSelect={vi.fn()}
      onAdd={vi.fn()}
      activeSection="overview"
      onSection={vi.fn()}
      applicationVersion={applicationVersion}
    />,
  );
}

describe('application version label', () => {
  it('uses the release-verified build version by default', () => {
    renderSidebar();

    expect(screen.getByText(`v${applicationVersion}`)).toBeInTheDocument();
  });

  it('renders the full supplied semantic version', () => {
    renderSidebar('9.8.7');

    expect(screen.getByText('v9.8.7')).toBeInTheDocument();
  });

  it('preserves prerelease and build metadata', () => {
    renderSidebar('9.8.7-beta.1+build.5');

    expect(screen.getByText('v9.8.7-beta.1+build.5')).toBeInTheDocument();
  });

  it('does not contain a hard-coded abbreviated product version or obsolete NexusOps mark', () => {
    expect(hostSidebarSource).not.toContain('v0.1');
    expect(hostSidebarSource).not.toMatch(/>\s*N\s*</);
    expect(ubgopsSvgSource).not.toContain('#56c8b2');
    expect(ubgopsSvgSource).not.toContain('M9 24V8l14 16V8');
  });
});

describe('HostSidebar navigation rail, filtering, and collapse', () => {
  it('filters sidebar hosts cleanly and restores empty filter results', async () => {
    const onSelect = vi.fn();
    render(
      <HostSidebar
        hosts={sampleHosts}
        selectedId="h1"
        onSelect={onSelect}
        onAdd={vi.fn()}
        activeSection="overview"
        onSection={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Gateway Alpha/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Worker Beta/i })).toBeInTheDocument();

    const filter = screen.getByRole('searchbox', { name: 'Filter sidebar hosts' });
    await userEvent.type(filter, 'worker.example');
    expect(screen.queryByRole('button', { name: /Gateway Alpha/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Worker Beta/i }));
    expect(onSelect).toHaveBeenCalledWith('h2');

    await userEvent.clear(filter);
    await userEvent.type(filter, 'nonexistent-host');
    expect(screen.getByText('No matching hosts.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(screen.getByRole('button', { name: /Gateway Alpha/i })).toBeInTheDocument();
  });

  it('supports keyboard navigation across rail items and toggling collapsed sidebar', async () => {
    const onToggleCollapse = vi.fn();
    const view = render(
      <HostSidebar
        hosts={sampleHosts}
        selectedId="h1"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        activeSection="overview"
        onSection={vi.fn()}
        collapsed={false}
        onToggleCollapse={onToggleCollapse}
      />,
    );

    const overviewBtn = screen.getByRole('button', { name: 'Overview' });
    overviewBtn.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Terminal' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'Security' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(overviewBtn).toHaveFocus();

    const collapseBtn = screen.getByRole('button', { name: 'Collapse hosts sidebar' });
    expect(collapseBtn).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(collapseBtn);
    expect(onToggleCollapse).toHaveBeenCalledOnce();

    view.rerender(
      <HostSidebar
        hosts={sampleHosts}
        selectedId="h1"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        activeSection="overview"
        onSection={vi.fn()}
        collapsed
        onToggleCollapse={onToggleCollapse}
      />,
    );
    expect(screen.queryByRole('searchbox', { name: 'Filter sidebar hosts' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand hosts sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
