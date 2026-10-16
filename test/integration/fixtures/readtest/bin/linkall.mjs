export default async function main(ctx) {
  const pairs = ctx.argv.slice(1);
  for (let i = 0; i < pairs.length; i += 2) await ctx.fs.symlink(pairs[i], pairs[i + 1]);
}
