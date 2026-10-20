import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const b64 = (text) => Buffer.from(text).toString('base64');

const PROGRAM = `const tries = {
  plain: () => import('data:text/javascript;base64,${b64('export default 5')}'),
  asJson: () => import('data:text/javascript;base64,${b64('export default 6')}', { with: { type: 'json' } }),
  json: () => import('data:application/json;base64,${b64('{"seven":7}')}', { with: { type: 'json' } }),
};
export default async function main(ctx) {
  const out = {};
  for (const [name, load] of Object.entries(tries)) {
    try {
      const m = await load();
      out[name] = m.default;
    } catch (err) {
      out[name] = err.code ?? err.name;
    }
  }
  await ctx.write(1, JSON.stringify(out));
  return 0;
}
`;

test("a JS program's nested base64 data: imports on the Node entry keep Node's import-attribute rules: JavaScript asked for as JSON is refused, a JSON module with the json attribute loads, and plain JavaScript runs (#1302)", async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/imports/package.json',
    JSON.stringify({
      name: 'imports',
      slicc: { commands: { imports: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/imports/main.mjs', PROGRAM);
  const r = await kernel.run(['imports'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    plain: 5,
    asJson: 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE',
    json: { seven: 7 },
  });
});
