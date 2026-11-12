import type { ProcessLink } from '../async/link.ts';
import { digest, type Images, imageOf } from './images.ts';
import type { IsolateGate } from './isolates.ts';
import { openLink, type ProcessHostStub } from './kernel-end.ts';

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
  open(init: unknown): Promise<ProcessLink>;
  admit(module: unknown): Promise<() => void>;
  workerId(image: string): Promise<string>;
  readonly loads: number;
}

export function cloudflareProcesses(
  loader: WorkerLoaderLike,
  images: Images,
  gate: IsolateGate,
  code: ProcessHostCode
): Processes {
  let hostDigest: Promise<string> | undefined;
  let loads = 0;
  const workerId = async (image: string): Promise<string> => {
    hostDigest ??= digest(`${code.host}\u0000${code.process}`);
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
    };
  };
  const reservations = new Map<string, (() => void)[]>();
  const reservedFor = (image: string): (() => void) | undefined => {
    const list = reservations.get(image);
    const release = list?.shift();
    if (list?.length === 0) reservations.delete(image);
    return release;
  };
  return {
    workerId,
    get loads() {
      return loads;
    },
    async admit(module) {
      const image = imageOf(module);
      if (image === undefined) return () => {};
      const release = await gate.acquire(await workerId(image));
      const list = reservations.get(image) ?? [];
      list.push(release);
      reservations.set(image, list);
      return () => {
        const at = list.indexOf(release);
        if (at < 0) return;
        list.splice(at, 1);
        if (list.length === 0 && reservations.get(image) === list) reservations.delete(image);
        release();
      };
    },
    async open(init) {
      const image = imageOfInit(init);
      if (image === undefined) throw new Error('this host runs only wasm programs with an image');
      const reserved = reservedFor(image);
      if (!images.has(image)) {
        reserved?.();
        throw new Error(`no program image ${image}`);
      }
      const id = await workerId(image);
      const release = reserved ?? (await gate.acquire(id));
      try {
        const host = loader.get(id, () => workerCode(image)).getEntrypoint() as ProcessHostStub;
        return await openLink(host, release);
      } catch (err) {
        release();
        throw err;
      }
    },
  };
}
