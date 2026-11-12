import { WorkerEntrypoint } from 'cloudflare:workers';
import { asyncProcessEntry } from 'slicc:process';
import program from 'slicc:program';
import { type ProcessEnd, processSide } from './process-end.ts';
import type { KernelEndStub } from './rpc-link.ts';

export default class ProcessHost extends WorkerEntrypoint {
  open(kernel: KernelEndStub): ProcessEnd {
    const { end, link } = processSide(kernel.dup());
    void asyncProcessEntry(link, { module: () => program });
    return end;
  }
}
