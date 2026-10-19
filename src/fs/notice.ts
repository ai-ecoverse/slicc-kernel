export interface FsNotice {
  paths?: readonly string[];
  trees?: readonly string[];
}

export function dirsChannel(metadata: string): string {
  return `slicc-kernel-dirs:${metadata}`;
}

export function noticeOf(data: unknown): { paths: string[]; trees: string[] } {
  if (Array.isArray(data)) return { paths: data.filter((p) => typeof p === 'string'), trees: [] };
  const notice = (data ?? {}) as FsNotice;
  const strings = (list: unknown) =>
    Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
  return { paths: strings(notice.paths), trees: strings(notice.trees) };
}
