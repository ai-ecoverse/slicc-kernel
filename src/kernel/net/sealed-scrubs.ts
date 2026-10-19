import type { Scrubber } from '@ai-ecoverse/slicc-scrub';
import { type ScrubSecret, scrubberOf } from '../scrub-file.ts';

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

  add(pid: number, host: string, secrets: readonly ScrubSecret[]): void {
    const tree = this.treeOf(pid);
    const entry = tree.get(host) ?? { secrets: [], version: 0, scrubber: undefined };
    const fresh = secrets.filter((s) => !entry.secrets.some((e) => e.value === s.value));
    if (fresh.length === 0) return;
    entry.secrets = [...entry.secrets, ...fresh];
    entry.version += 1;
    entry.scrubber = undefined;
    tree.set(host, entry);
  }

  of(pid: number, host: string): SessionScrub | undefined {
    const entry = this.trees.get(pid)?.get(host);
    if (!entry) return undefined;
    entry.scrubber ??= scrubberOf(entry.secrets);
    return entry.scrubber ? { version: entry.version, scrubber: entry.scrubber } : undefined;
  }

  drop(pid: number): void {
    this.trees.delete(pid);
  }
}
