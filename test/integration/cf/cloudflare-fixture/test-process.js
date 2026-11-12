let isolate;
const stats = { opened: 0, ended: 0, closedCalls: 0, closedByKernel: 0 };

async function serve(link, module) {
  isolate ??= crypto.randomUUID();
  let blocked = false;
  link.onClose(() => {
    stats.closedByKernel++;
  });
  link.onMessage((message) => {
    if (message?.type === 'signal') link.post({ type: 'signalled', sig: message.sig, blocked });
  });
  const instance = new WebAssembly.Instance(module, {
    env: { sys: new WebAssembly.Suspending((i) => link.call({ op: 'sys', i })) },
  });
  const run = WebAssembly.promising(instance.exports.run);
  const section = WebAssembly.Module.customSections(module, 'slicc-image')[0];
  link.post({
    type: 'hello',
    isolate,
    stats: { ...stats },
    tag: section ? new TextDecoder().decode(section) : null,
  });
  for (;;) {
    const cmd = await link.call({ op: 'next' });
    if (cmd.do === 'wasm') {
      const started = Date.now();
      link.post({ type: 'sum', sum: await run(cmd.n), ms: Date.now() - started });
    } else if (cmd.do === 'read') {
      blocked = true;
      const data = await link.call({ op: 'read' });
      blocked = false;
      link.post({ type: 'read', data });
    } else if (cmd.do === 'big') {
      const back = await link.call({ op: 'big', bytes: new Uint8Array(cmd.size).fill(7) });
      link.post({
        type: 'big',
        sent: cmd.size,
        got: back.bytes.byteLength,
        last: back.bytes[back.bytes.byteLength - 1],
        kind: back.bytes.constructor.name,
      });
    } else if (cmd.do === 'close') {
      link.close();
      return;
    } else if (cmd.do === 'exit') {
      link.post({ type: 'exit', code: cmd.code });
      return;
    }
  }
}

export function asyncProcessEntry(link, deps) {
  stats.opened++;
  return Promise.resolve(deps.module('program'))
    .then((module) => serve(link, module))
    .catch((err) => {
      if (String(err?.message ?? err).includes('closed')) stats.closedCalls++;
    })
    .finally(() => {
      stats.ended++;
    });
}
