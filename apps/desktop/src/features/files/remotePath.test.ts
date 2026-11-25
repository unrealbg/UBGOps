import { describe, expect, it } from 'vitest';
import { buildRemoteBreadcrumbs, parentRemotePath } from './remotePath';

describe('remotePath helpers', () => {
  it('computes parent POSIX remote paths consistently with backend rules', () => {
    expect(parentRemotePath('')).toBeNull();
    expect(parentRemotePath('/')).toBeNull();
    expect(parentRemotePath('///')).toBeNull();
    expect(parentRemotePath('/home')).toBe('/');
    expect(parentRemotePath('/home/test')).toBe('/home');
    expect(parentRemotePath('/home/test/')).toBe('/home');
    expect(parentRemotePath('/symlink target/child name')).toBe('/symlink target');
    expect(parentRemotePath('relative')).toBe('.');
  });

  it('builds literal ancestor breadcrumbs preserving spaces, Unicode, and special characters', () => {
    expect(buildRemoteBreadcrumbs('/')).toEqual([{ label: '/', path: '/' }]);
    expect(buildRemoteBreadcrumbs('/home/test')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'test', path: '/home/test' },
    ]);
    expect(buildRemoteBreadcrumbs('/var/dir with spaces/café#1?x=1%20/release/')).toEqual([
      { label: '/', path: '/' },
      { label: 'var', path: '/var' },
      { label: 'dir with spaces', path: '/var/dir with spaces' },
      { label: 'café#1?x=1%20', path: '/var/dir with spaces/café#1?x=1%20' },
      { label: 'release', path: '/var/dir with spaces/café#1?x=1%20/release' },
    ]);
  });
});
