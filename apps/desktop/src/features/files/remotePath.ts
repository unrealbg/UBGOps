export type RemoteBreadcrumb = {
  label: string;
  path: string;
};

/** Computes the parent remote POSIX path, mirroring crates/ubgops-sftp/src/path.rs::parent_remote. */
export function parentRemotePath(path: string): string | null {
  if (!path || path === '/') return null;
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return null;
  const slashIndex = trimmed.lastIndexOf('/');
  if (slashIndex === -1) return '.';
  if (slashIndex === 0) return '/';
  return trimmed.slice(0, slashIndex);
}

/** Splits a remote POSIX path into interactive ancestor segments without decoding or normalizing symlinks. */
export function buildRemoteBreadcrumbs(path: string): RemoteBreadcrumb[] {
  if (!path) return [];
  if (path.startsWith('/')) {
    const trimmed = path.replace(/\/+$/, '');
    if (!trimmed) {
      return [{ label: '/', path: '/' }];
    }
    const crumbs: RemoteBreadcrumb[] = [{ label: '/', path: '/' }];
    let accumulated = '';
    for (const segment of trimmed.slice(1).split('/')) {
      if (!segment) continue;
      accumulated = `${accumulated}/${segment}`;
      crumbs.push({ label: segment, path: accumulated });
    }
    return crumbs;
  }

  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return [];
  const crumbs: RemoteBreadcrumb[] = [];
  let accumulated = '';
  for (const segment of trimmed.split('/')) {
    if (!segment) continue;
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    crumbs.push({ label: segment, path: accumulated });
  }
  return crumbs;
}
