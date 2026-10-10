export default async function main(ctx) {
  await ctx.write(1, `${ctx.argv.join('|')}\n`);
}
