import type { MountEntry, MountSpec } from './mount-fs.ts';
import { parseMountOptions } from './syscall.ts';

export const FSTAB_PATH = '/etc/fstab';

export const FSTAB_RETRIES = [1000, 4000, 16000];

const FINAL = new Set(['EINVAL', 'EBUSY', 'EPERM', 'EACCES']);

export interface FstabLine {
  line: number;
  spec: MountSpec;
  invalid?: Error;
}

export interface FstabResult {
  line: number;
  target: string;
  entry?: MountEntry;
  code?: string;
  error?: string;
}

function unescape(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  );
}

export function parseFstab(text: string): FstabLine[] {
  const lines: FstabLine[] = [];
  text.split('\n').forEach((raw, index) => {
    const content = raw.replace(/#.*$/, '').trim();
    if (!content) return;
    const [source, target, type, options = 'defaults'] = content.split(/\s+/).map(unescape);
    if (source === undefined || target === undefined || type === undefined) return;
    if (options.split(',').includes('noauto')) return;
    const spec = { source, target, type, options: {} };
    try {
      lines.push({ line: index + 1, spec: { ...spec, options: parseMountOptions(options) } });
    } catch (err) {
      lines.push({ line: index + 1, spec, invalid: err as Error });
    }
  });
  return lines;
}

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'EIO';
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function mountFstab(
  lines: readonly FstabLine[],
  mount: (spec: MountSpec) => Promise<MountEntry>,
  signal: AbortSignal,
  retries: readonly number[] = FSTAB_RETRIES,
  discard: (entry: MountEntry) => void = () => {}
): Promise<FstabResult[]> {
  return Promise.all(
    lines.map(async ({ line, spec, invalid }) => {
      let failed: unknown = invalid;
      for (let attempt = 0; !invalid && attempt <= retries.length && !signal.aborted; attempt++) {
        try {
          const entry = await mount(spec);
          if (!signal.aborted) return { line, target: spec.target, entry };
          discard(entry);
          failed = Object.assign(new Error('the kernel stopped'), { code: 'ECANCELED' });
          break;
        } catch (err) {
          failed = err;
          if (FINAL.has(codeOf(err)) || attempt === retries.length) break;
          await wait(retries[attempt] as number, signal);
        }
      }
      const code = codeOf(failed);
      return { line, target: spec.target, code, error: String((failed as Error)?.message ?? code) };
    })
  );
}
