export default async function main(ctx) {
  const path = ctx.argv[1];
  const bytes = ctx.sync.fs.readFile(path);
  let sum = 0;
  for (const b of bytes) sum = (sum * 31 + b) >>> 0;
  await ctx.write(1, `${bytes.length} ${sum}\n`);
  return 0;
}
