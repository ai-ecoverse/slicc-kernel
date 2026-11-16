import { WorkerEntrypoint } from 'cloudflare:workers';
import * as programImports from 'slicc:imports';
import { asyncProcessEntry } from 'slicc:process';
import program from 'slicc:program';
import { type ForkSnapshots, forkSnapshots } from '../async/snapshots.ts';
import { digest } from './images.ts';
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

interface ProcessHostEnv {
  SLICC_LOCAL_FORKS?: string;
  SLICC_IMPORTS?: string;
}

const OTHER_IMPORTS =
  'this Dynamic Worker was loaded with another imports module than the program names';

export default class ProcessHost extends WorkerEntrypoint<ProcessHostEnv> {
  open(kernel: KernelEndStub): ProcessEnd {
    const store = this.env?.SLICC_LOCAL_FORKS === 'off' ? kernelOnly : snapshots;
    const loaded = this.env?.SLICC_IMPORTS;
    const imports = async (source: string) => {
      if (loaded === undefined || (await digest(source)) !== loaded) throw new Error(OTHER_IMPORTS);
      return programImports as Record<string, unknown>;
    };
    const { end, link } = processSide(kernel.dup(), store);
    void asyncProcessEntry(link, {
      module: () => program,
      imports,
      snapshots: store,
      deadlines: false,
    });
    return end;
  }
}
