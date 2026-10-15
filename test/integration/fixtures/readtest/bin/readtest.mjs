const text = (bytes) => new TextDecoder().decode(bytes);

export default async function main(ctx) {
  for (const path of ctx.argv.slice(1)) {
    const async = await ctx.fs.readFile(path).then(text, (err) => err.code);
    let sync;
    try {
      sync = text(ctx.sync.fs.readFile(path));
    } catch (err) {
      sync = err.code;
    }
    await ctx.write(1, `${async} ${sync}\n`);
  }
}
