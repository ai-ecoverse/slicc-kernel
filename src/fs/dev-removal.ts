export function inDevTree(path: string): boolean {
  return path === '/dev' || path.startsWith('/dev/');
}

export function devRemoval(
  path: string,
  cred: Readonly<{ euid: number }> | undefined
): 'EACCES' | 'EPERM' | 'EBUSY' | undefined {
  if (!inDevTree(path)) return undefined;
  if (cred && cred.euid !== 0) return 'EACCES';
  return path === '/dev' ? 'EBUSY' : 'EPERM';
}
