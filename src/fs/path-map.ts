function parentOf(path: string): string | undefined {
  if (path === '/' || path === '') return undefined;
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}

export class PathMap<V> {
  private readonly values = new Map<string, V>();
  private readonly children = new Map<string, Set<string>>();

  get size(): number {
    return this.values.size;
  }

  has(path: string): boolean {
    return this.values.has(path);
  }

  get(path: string): V | undefined {
    return this.values.get(path);
  }

  keys(): IterableIterator<string> {
    return this.values.keys();
  }

  set(path: string, value: V): this {
    if (!this.values.has(path)) this.link(path);
    this.values.set(path, value);
    return this;
  }

  delete(path: string): boolean {
    if (!this.values.delete(path)) return false;
    this.prune(path);
    return true;
  }

  subtree(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    for (let path = stack.pop(); path !== undefined; path = stack.pop()) {
      if (this.values.has(path)) out.push(path);
      const below = this.children.get(path);
      if (below) for (const child of below) stack.push(child);
    }
    return out;
  }

  entries(): IterableIterator<[string, V]> {
    return this.values.entries();
  }

  deleteTree(root: string): void {
    const stack = [root];
    for (let path = stack.pop(); path !== undefined; path = stack.pop()) {
      this.values.delete(path);
      const below = this.children.get(path);
      if (below) for (const child of below) stack.push(child);
      this.children.delete(path);
    }
    this.prune(root);
  }

  clear(): void {
    this.values.clear();
    this.children.clear();
  }

  private link(path: string): void {
    for (let child = path, parent = parentOf(path); parent !== undefined; ) {
      const set = this.children.get(parent);
      if (set?.has(child)) return;
      if (set) set.add(child);
      else this.children.set(parent, new Set([child]));
      child = parent;
      parent = parentOf(parent);
    }
  }

  private prune(path: string): void {
    for (let child = path, parent = parentOf(path); parent !== undefined; ) {
      if (this.values.has(child) || this.children.has(child)) return;
      const set = this.children.get(parent);
      set?.delete(child);
      if (set && set.size > 0) return;
      this.children.delete(parent);
      child = parent;
      parent = parentOf(parent);
    }
  }
}
