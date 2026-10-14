export default async function main(ctx) {
  const out = {};
  for (const path of ctx.argv.slice(1)) {
    try {
      out[path] = { async: await ctx.fs.statfs(path), sync: ctx.sync.fs.statfs(path) };
    } catch (err) {
      out[path] = { error: err.code };
    }
  }
  await ctx.write(1, `${JSON.stringify(out)}\n`);
}
