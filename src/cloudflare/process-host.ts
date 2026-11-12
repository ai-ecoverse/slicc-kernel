import { WorkerEntrypoint } from 'cloudflare:workers';
import { asyncProcessEntry } from 'slicc:process';
import program from 'slicc:program';
import { type ForkSnapshots, forkSnapshots } from '../async/snapshots.ts';
import { type ProcessEnd, processSide } from './process-end.ts';
import type { KernelEndStub } from './rpc-link.ts';

const snapshots = forkSnapshots();

const kernelOnly: ForkSnapshots = {
  keep: (bytes) => snapshots.keep(bytes),
  take: () => undefined,
  read: (token, offset, max) => snapshots.read(token, offset, max),
  release: (token) => snapshots.release(token),
  get size() {
    return snapshots.size;
  },
};

export default class ProcessHost extends WorkerEntrypoint<{ SLICC_LOCAL_FORKS?: string }> {
  open(kernel: KernelEndStub): ProcessEnd {
    const store = this.env?.SLICC_LOCAL_FORKS === 'off' ? kernelOnly : snapshots;
    const { end, link } = processSide(kernel.dup(), store);
    void asyncProcessEntry(link, { module: () => program, snapshots: store });
    return end;
  }
}
