import type { ProcessLink } from '../async/link.ts';
import { ForkTokens } from './fork-tokens.ts';
import { digest, type Images, imageOf } from './images.ts';
import type { IsolateGate } from './isolates.ts';
import { openLink, type ProcessHostStub } from './kernel-end.ts';
import { type ImageSize, Placement, type Seat } from './placement.ts';

export type WorkerModule =
  | string
  | { js: string }
  | { wasm: ArrayBuffer }
  | { text: string }
  | { data: ArrayBuffer }
  | { json: unknown };

export interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, WorkerModule>;
  globalOutbound?: null;
  env?: Record<string, unknown>;
}

export interface WorkerLoaderLike {
  get(
    id: string,
    code: () => WorkerCode | Promise<WorkerCode>
  ): { getEntrypoint(name?: string): unknown };
}

export interface ProcessHostCode {
  host: string;
  process: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  localForks?: boolean;
}

export const PROCESS_COMPATIBILITY_DATE = '2026-09-01';

interface InitLike {
  program?: { module?: unknown; image?: unknown; abi?: unknown };
}

export function imageOfInit(init: unknown): string | undefined {
  const program = (init as InitLike | null | undefined)?.program;
  if (!program) return undefined;
  return imageOf(program.module) ?? (typeof program.image === 'string' ? program.image : undefined);
}

export interface Processes {
  readonly forks: ForkTokens;
  readonly placement: Placement;
  open(init: unknown): Promise<ProcessLink>;
  admit(module: unknown, from?: { ppid?: number }): Promise<() => void>;
  workerId(image: string): Promise<string>;
  readonly loads: number;
}

export interface IsolateMemory {
  budget?: number;
  perInstance?: number;
  clock?: () => Promise<unknown>;
}

interface ForkInit {
  pid?: unknown;
  ppid?: unknown;
  fork?: { ppid?: unknown; snapshot?: { total?: unknown }; memory?: unknown };
}

function forkNeed(init: ForkInit): number | undefined {
  const total = init.fork?.snapshot?.total;
  if (typeof total === 'number' && total > 0) return total;
  const memory = init.fork?.memory as { byteLength?: unknown; total?: unknown } | undefined;
  const length = memory?.byteLength ?? memory?.total;
  return typeof length === 'number' && length > 0 ? length : undefined;
}

function parentOf(init: ForkInit): number | undefined {
  const ppid = init.fork?.ppid ?? init.ppid;
  return init.fork && typeof ppid === 'number' ? ppid : undefined;
}

export function cloudflareProcesses(
  loader: WorkerLoaderLike,
  images: Images,
  gate: IsolateGate,
  code: ProcessHostCode,
  memory: IsolateMemory = {}
): Processes {
  let hostDigest: Promise<string> | undefined;
  let loads = 0;
  const workerId = async (image: string): Promise<string> => {
    hostDigest ??= digest(`${code.host}\u0000${code.process}\u0000${code.localForks !== false}`);
    return `slicc-${(await hostDigest).slice(0, 16)}-${image.slice(0, 40)}`;
  };
  const workerCode = (image: string): WorkerCode => {
    loads++;
    return {
      compatibilityDate: code.compatibilityDate ?? PROCESS_COMPATIBILITY_DATE,
      ...(code.compatibilityFlags ? { compatibilityFlags: code.compatibilityFlags } : {}),
      mainModule: 'host.js',
      modules: {
        'host.js': code.host,
        'process.js': code.process,
        'program.wasm': { wasm: images.get(image) },
      },
      globalOutbound: null,
      ...(code.localForks === false ? { env: { SLICC_LOCAL_FORKS: 'off' } } : {}),
    };
  };
  const forks = new ForkTokens();
  const placement = new Placement(gate, { ...memory, waitMs: gate.waitMs });
  const reservations = new Map<string, Seat[]>();
  const seated = new Map<number, Seat>();
  const sizeOf = async (image: string): Promise<ImageSize> => ({
    image,
    base: await workerId(image),
    ...images.sizeOf(image),
  });
  const reservedFor = (image: string): Seat | undefined => {
    const list = reservations.get(image);
    const seat = list?.shift();
    if (list?.length === 0) reservations.delete(image);
    return seat;
  };
  const depthOf = (ppid: number | undefined): number => {
    const parent = ppid === undefined ? undefined : seated.get(ppid);
    return parent ? parent.depth + 1 : 0;
  };
  const nearParent = (
    size: ImageSize,
    init: ForkInit,
    seat: Seat | undefined
  ): Seat | undefined => {
    const ppid = parentOf(init);
    const parent = ppid === undefined ? undefined : seated.get(ppid);
    if (!parent || parent.image !== size.image || parent.shard === seat?.shard) return seat;
    const moved = placement.tryOn(size, parent.shard, forkNeed(init), parent.depth + 1);
    if (!moved) return seat;
    seat?.release();
    return moved;
  };
  return {
    forks,
    placement,
    workerId,
    get loads() {
      return loads;
    },
    async admit(module, from = {}) {
      const image = imageOf(module);
      if (image === undefined || !images.has(image)) return () => {};
      const seat = await placement.place(await sizeOf(image), undefined, depthOf(from.ppid));
      const list = reservations.get(image) ?? [];
      list.push(seat);
      reservations.set(image, list);
      return () => {
        const at = list.indexOf(seat);
        if (at < 0) return;
        list.splice(at, 1);
        if (list.length === 0 && reservations.get(image) === list) reservations.delete(image);
        seat.release();
      };
    },
    async open(init) {
      const image = imageOfInit(init);
      if (image === undefined) throw new Error('this host runs only wasm programs with an image');
      const reserved = reservedFor(image);
      if (!images.has(image)) {
        reserved?.release();
        throw new Error(`no program image ${image}`);
      }
      const size = await sizeOf(image);
      const forkInit = init as ForkInit;
      const need = forkNeed(forkInit);
      const seat = nearParent(size, forkInit, reserved) ?? (await placement.place(size, need));
      if (need !== undefined) seat.memory(need);
      const pid = typeof forkInit.pid === 'number' ? forkInit.pid : undefined;
      if (pid !== undefined) seated.set(pid, seat);
      const release = (): void => {
        if (pid !== undefined && seated.get(pid) === seat) seated.delete(pid);
        seat.release();
      };
      try {
        const host = loader
          .get(seat.id, () => workerCode(image))
          .getEntrypoint() as ProcessHostStub;
        return await openLink(host, release, {
          forks,
          sized: (bytes) => seat.memory(bytes),
          holds: (bytes) => seat.hold(bytes),
          ...(memory.clock ? { refresh: memory.clock } : {}),
        });
      } catch (err) {
        release();
        throw err;
      }
    },
  };
}
