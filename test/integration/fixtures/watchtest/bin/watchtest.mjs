const line = (note) =>
  'ended' in note
    ? 'ended'
    : 'overflow' in note
      ? 'overflow'
      : `${note.type} ${note.filename}${note.moved ? ' moved' : ''}`;

async function events(ctx, [path, end, ready, ...flags]) {
  const notes = [];
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  let over = false;
  const stream = flags.includes('stream');
  const listener = (note) => {
    if (over) return;
    notes.push(line(note));
    if (stream) void ctx.write(1, `${line(note)}\n`);
    over = 'ended' in note || note.filename === end;
    if ('ended' in note || note.filename === end) done();
  };
  const options = { recursive: flags.includes('recursive') };
  const watcher = flags.includes('sync')
    ? ctx.sync.fs.watch(path, options, listener)
    : await ctx.fs.watch(path, options, listener);
  await ctx.fs.writeFile(ready, '');
  await finished;
  watcher.close();
  watcher.close();
  if (!stream) await ctx.write(1, `${notes.join('\n')}\n`);
}

async function refused(ctx, [path]) {
  for (const watch of [
    () => ctx.fs.watch(path, () => {}),
    async () => ctx.sync.fs.watch(path, () => {}),
  ]) {
    try {
      (await watch()).close();
      await ctx.write(1, 'watched\n');
    } catch (err) {
      await ctx.write(1, `${err.code}\n`);
    }
  }
}

async function closed(ctx, [dir]) {
  const notes = [];
  const watcher = ctx.sync.fs.watch(dir, (note) => notes.push(line(note)));
  watcher.close();
  watcher.close();
  ctx.sync.fs.writeFile(`${dir}/after`, 'x');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await ctx.write(1, `${notes.length}\n`);
}

async function leave(ctx, [dir]) {
  await ctx.fs.watch(dir, () => {});
  await ctx.write(1, 'left\n');
}

async function flood(ctx, [dir, count]) {
  const notes = [];
  const watcher = ctx.sync.fs.watch(dir, (note) => notes.push(line(note)));
  for (let i = 0; i < Number(count); i++) ctx.sync.fs.writeFile(`${dir}/f${i}`, 'x');
  for (let i = 0; i < 50 && !notes.includes('overflow'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  watcher.close();
  await ctx.write(1, `${notes.includes('overflow')} ${notes.indexOf('overflow') > 0}\n`);
}

async function rewrite(ctx, [dir, name, ready, end]) {
  const notes = [];
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  const watcher = ctx.sync.fs.watch(dir, (note) => {
    if (note.filename === end) done();
    else if (note.filename === name) notes.push(line(note));
  });
  await ctx.fs.writeFile(ready, '');
  await finished;
  watcher.close();
  await ctx.write(1, `${notes.join('\n')}\n`);
}

async function sequence(ctx, [a, b]) {
  const notes = [];
  const seen = (label) => (note) => notes.push({ label, note });
  const wa = ctx.sync.fs.watch(a, seen('A'));
  const wb = ctx.sync.fs.watch(b, seen('B'));
  const wf = ctx.sync.fs.watch(`${a}/x`, seen('F'));
  ctx.sync.fs.writeFile(`${a}/x`, '1');
  ctx.sync.fs.writeFile(`${b}/y`, '2');
  ctx.sync.fs.writeFile(`${a}/x`, '3');
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const w of [wa, wb, wf]) w.close();
  const numbered = notes.every(({ note }) => Number.isInteger(note.seq) && note.seq > 0);
  const order = [...notes].sort(
    (p, q) => p.note.seq - q.note.seq || p.label.localeCompare(q.label)
  );
  const out = order.map(({ label, note }) => `${label} ${line(note)}`);
  const by = new Map();
  for (const { label, note } of notes)
    by.set(`${note.seq}`, [...(by.get(`${note.seq}`) ?? []), label].sort());
  const shared = [...by.values()].filter((labels) => labels.length > 1).map((l) => l.join('+'));
  await ctx.write(1, `${numbered}\n${out.join('\n')}\n${shared.join(' ')}\n`);
}

const MODES = { events, refused, closed, leave, flood, rewrite, sequence };

export default async function main(ctx) {
  const [mode, ...rest] = ctx.argv.slice(1);
  await MODES[mode](ctx, rest);
}
