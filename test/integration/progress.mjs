import { setTimeout as sleep } from 'node:timers/promises';

const PROC_STATS =
  'for f in /proc/[0-9]*/stat; do read -r l < "$f" && echo "$l"; done; echo "self $$"';

export function processTree(bash) {
  return async () => {
    const { stdout } = await bash(PROC_STATS);
    const self = stdout.match(/^self (\d+)$/m)?.[1];
    const procs = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(\d+) \((.*)\) (\S) (.*)$/);
      if (!m || m[1] === self) continue;
      const fields = m[4].split(' ');
      const ticks = Number(fields[10]) + Number(fields[11]);
      procs.push({ pid: Number(m[1]), comm: m[2], state: m[3], ticks });
    }
    return procs;
  };
}

const shown = (procs) =>
  procs.map((p) => `  ${p.pid} ${p.comm} ${p.state} cpu ${p.ticks / 100} s`).join('\n');

export async function progressing(work, options) {
  const { sample, quietMs = 60_000, maxMs, everyMs = 5_000, label = 'the work' } = options;
  const where = options.where ?? (async () => '');
  const started = Date.now();
  let settled = false;
  const result = Promise.resolve(work).finally(() => (settled = true));
  result.catch(() => undefined);
  let seen = '';
  let procs = [];
  let movedAt = started;
  const fail = async (why) => {
    const extra = await where().catch((err) => `where: ${err.message}`);
    const tail = extra ? `\n${extra}` : '';
    return new Error(`${label}: ${why}; processes:\n${shown(procs)}${tail}`);
  };
  const watch = async () => {
    for (;;) {
      await sleep(everyMs);
      if (settled) return;
      try {
        procs = await sample();
      } catch {
        continue;
      }
      if (settled) return;
      const now = Date.now();
      const state = procs.map((p) => `${p.pid}:${p.ticks}`).join(' ');
      if (state !== seen) {
        seen = state;
        movedAt = now;
      }
      if (now - movedAt >= quietMs) {
        throw await fail(
          `no progress for ${Math.round((now - movedAt) / 1000)} s after ${Math.round((now - started) / 1000)} s`
        );
      }
      if (maxMs !== undefined && now - started >= maxMs) {
        throw await fail(
          `still running after ${Math.round((now - started) / 1000)} s, the outer bound`
        );
      }
    }
  };
  const watching = watch();
  try {
    return await Promise.race([result, watching.then(() => result)]);
  } finally {
    settled = true;
  }
}

export async function pageBash(page, script, options = { cwd: '/os' }, everyMs = 1_000) {
  const id = await page.evaluate(
    (s, o) => {
      const runs = (window.longRuns ??= []);
      const slot = { done: false };
      runs.push(slot);
      window.kernel.run(['bash', '-c', s], o).then(
        (result) => Object.assign(slot, { done: true, result }),
        (err) => Object.assign(slot, { done: true, error: String(err?.message ?? err) })
      );
      return runs.length - 1;
    },
    script,
    options
  );
  for (;;) {
    const slot = await page.evaluate((i) => window.longRuns[i], id);
    if (slot.done) {
      if (slot.error !== undefined) throw new Error(slot.error);
      return slot.result;
    }
    await sleep(everyMs);
  }
}
