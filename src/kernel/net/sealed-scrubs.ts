import { scrubberOf } from '../scrub-file.ts';

export interface ScrubSecret {
  name: string;
  value: string;
  placeholder: string;
}

export interface ScrubStream {
  push(chunk: Uint8Array): Uint8Array;
  idle(): Uint8Array;
  end(): Uint8Array;
}

export interface Scrubber {
  stream(): ScrubStream;
}

interface Entry {
  secrets: ScrubSecret[];
  version: number;
  scrubber: Scrubber | undefined;
}

type Tree = Map<string, Entry>;

export interface SessionScrub {
  version: number;
  scrubber: Scrubber;
}

export interface ScrubScope {
  add(secrets: readonly ScrubSecret[]): void;
  of(): SessionScrub | undefined;
}

function addTo(tree: Tree, host: string, secrets: readonly ScrubSecret[]): void {
  const entry = tree.get(host) ?? { secrets: [], version: 0, scrubber: undefined };
  const fresh = secrets.filter((s) => !entry.secrets.some((e) => e.value === s.value));
  if (fresh.length === 0) return;
  entry.secrets = [...entry.secrets, ...fresh];
  entry.version += 1;
  entry.scrubber = undefined;
  tree.set(host, entry);
}

function scrubOf(tree: Tree | undefined, host: string): SessionScrub | undefined {
  const entry = tree?.get(host);
  if (!entry) return undefined;
  entry.scrubber ??= scrubberOf(entry.secrets, true);
  return entry.scrubber ? { version: entry.version, scrubber: entry.scrubber } : undefined;
}

export class SessionScrubs {
  private readonly trees = new Map<number, Tree>();

  private treeOf(pid: number): Tree {
    let tree = this.trees.get(pid);
    if (!tree) {
      tree = new Map();
      this.trees.set(pid, tree);
    }
    return tree;
  }

  inherit(parent: number, child: number): void {
    this.trees.set(child, this.treeOf(parent));
  }

  scope(pid: number, host: string): ScrubScope {
    const tree = this.treeOf(pid);
    return { add: (secrets) => addTo(tree, host, secrets), of: () => scrubOf(tree, host) };
  }

  add(pid: number, host: string, secrets: readonly ScrubSecret[]): void {
    addTo(this.treeOf(pid), host, secrets);
  }

  of(pid: number, host: string): SessionScrub | undefined {
    return scrubOf(this.trees.get(pid), host);
  }

  drop(pid: number): void {
    this.trees.delete(pid);
  }
}
