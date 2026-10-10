export default async function main(ctx) {
  const shown = [ctx.env.JSECHO_ENV, ctx.env.JSECHO_ENV2];
  const env = shown.some((v) => v !== undefined)
    ? `\nenv ${shown.map((v) => v ?? '-').join(' ')}`
    : '';
  await ctx.write(1, `${ctx.argv.join('|')}${env}\n`);
}
