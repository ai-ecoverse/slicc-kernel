const line = (note) =>
  'ended' in note ? 'ended' : 'overflow' in note ? 'overflow' : `${note.type} ${note.filename}`;

async function events(ctx, [path, end, ready, ...flags]) {
  const notes = [];
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  let over = false;
  const listener = (note) => {
    if (over) return;
    notes.push(line(note));
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
  await ctx.write(1, `${notes.join('\n')}\n`);
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

const MODES = { events, refused, closed, leave, flood };

export default async function main(ctx) {
  const [mode, ...rest] = ctx.argv.slice(1);
  await MODES[mode](ctx, rest);
}
