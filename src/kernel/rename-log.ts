import type { FileChanges } from '../fs/changes.ts';

export const RENAME_LOG_SIZE = 4096;

export interface RenamesSince {
  now: number;
  renames: Array<[string, string]>;
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
}

export class RenameLog {
  private readonly changes: FileChanges;
  private readonly entries: Array<{ seq: number; from: string; to: string }> = [];

  constructor(changes: FileChanges) {
    this.changes = changes;
  }

  add(from: string, to: string): number {
    const seq = this.changes.renamed();
    this.entries.push({ seq, from, to });
    if (this.entries.length > RENAME_LOG_SIZE) this.entries.shift();
    return seq;
  }

  since(seen: number, held: readonly string[]): RenamesSince {
    const now = this.entries.at(-1)?.seq ?? seen;
    const renames: Array<[string, string]> = [];
    let paths = [...held];
    for (const { seq, from, to } of this.entries) {
      if (seq <= seen || !paths.some((path) => within(path, from))) continue;
      renames.push([from, to]);
      paths = paths.map((path) => (within(path, from) ? to + path.slice(from.length) : path));
    }
    return { now, renames };
  }
}
