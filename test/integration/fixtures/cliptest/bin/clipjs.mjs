const DEVICE = '/dev/clipboard';

async function attempt(ctx, work) {
  try {
    await work();
    return 0;
  } catch (err) {
    await ctx.write(2, `clipjs: ${err.code} ${err.message}\n`);
    return 1;
  }
}

export default async function main(ctx) {
  const [, mode, text = ''] = ctx.argv;
  if (mode === 'paste') {
    return attempt(ctx, async () => {
      await ctx.write(1, new TextDecoder().decode(await ctx.fs.readFile(DEVICE)));
    });
  }
  if (mode === 'copy') return attempt(ctx, () => ctx.fs.writeFile(DEVICE, text));
  if (mode === 'stat') {
    const st = await ctx.fs.stat(DEVICE);
    const listed = (await ctx.fs.readdir('/dev')).includes('clipboard');
    await ctx.write(
      1,
      `${(st.mode & 0o170000).toString(8)} ${(st.mode & 0o777).toString(8)} ${listed}\n`
    );
    return 0;
  }
  if (mode === 'pieces') {
    return attempt(ctx, async () => {
      const file = await ctx.open(DEVICE, { write: true });
      for (const piece of text.split(',')) await file.write(0, new TextEncoder().encode(piece));
      await file.close();
    });
  }
  await ctx.write(2, 'usage: clipjs paste|copy|stat|pieces [text]\n');
  return 2;
}
