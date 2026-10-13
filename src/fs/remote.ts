export interface RemoteChange {
  paths: readonly string[];
  trees: readonly string[];
}

export type RemoteListener = (change: RemoteChange) => void;

interface WatchMessage {
  hello?: string;
  tab?: string;
  paths?: string[];
  changed?: string[];
}

export class RemoteWatch {
  private readonly channel: BroadcastChannel;
  private readonly tab = crypto.randomUUID();
  private readonly others = new Map<string, readonly string[]>();
  private readonly union = new Set<string>();
  private readonly listeners = new Set<RemoteListener>();
  private mine: readonly string[] = [];

  constructor(name: string) {
    this.channel = new BroadcastChannel(name);
    this.channel.onmessage = ({ data }) => this.receive(data as WatchMessage);
    (this.channel as BroadcastChannel & { unref?: () => void }).unref?.();
    this.channel.postMessage({ hello: this.tab });
  }

  private receive(data: WatchMessage): void {
    if (data.hello !== undefined && this.mine.length > 0) this.announce(this.mine);
    if (data.tab !== undefined && data.paths !== undefined) {
      if (data.paths.length > 0) this.others.set(data.tab, data.paths);
      else this.others.delete(data.tab);
      this.union.clear();
      for (const paths of this.others.values()) for (const path of paths) this.union.add(path);
    }
    if (data.changed !== undefined) this.emit({ paths: data.changed, trees: [] });
  }

  watched(): boolean {
    return this.union.size > 0;
  }

  wrote(path: string): void {
    if (this.union.has(path)) this.channel.postMessage({ changed: [path] });
  }

  announce(paths: readonly string[]): void {
    this.mine = [...paths];
    this.channel.postMessage({ tab: this.tab, paths: this.mine });
  }

  emit(change: RemoteChange): void {
    for (const listener of this.listeners) listener(change);
  }

  listen(listener: RemoteListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
