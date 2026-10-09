import { attachKernel } from '/dist/index.js';

let client;
const children = new Map();

const actions = {
  async attach({ port }) {
    client = await attachKernel(port);
    client.closed.then((error) => postMessage({ event: 'closed', name: error.name }));
    return { protocol: client.protocol };
  },
  forward({ port }) {
    postMessage({ event: 'forwarded', port }, [port]);
    return true;
  },
  async spawn({ argv, pgid }) {
    let out = '';
    const child = await client.spawn(argv, {
      ...(pgid !== undefined ? { pgid } : {}),
      onStdout: (bytes) => {
        out += new TextDecoder().decode(bytes);
      },
    });
    children.set(child.pid, child);
    child.exited.then(
      (status) => postMessage({ event: 'exited', pid: child.pid, status, out }),
      (error) => postMessage({ event: 'exited', pid: child.pid, error: error.name })
    );
    return { pid: child.pid, pgid: child.pgid };
  },
  ps: () => client.ps(),
  async fetchText({ url }) {
    const response = await client.fetch({ url, method: 'GET', headers: [] });
    let text = '';
    for await (const chunk of response.body) text += new TextDecoder().decode(chunk);
    return { status: response.status, text };
  },
  async files() {
    await client.fs.mkdir('/home/agent/sub');
    await client.fs.writeFile('/home/agent/sub/a.txt', 'from the agent');
    const listed = await client.fs.readdir('/home/agent/sub');
    const missing = await client.fs.stat('/home/agent/none').catch((e) => e.code);
    return { listed, text: await client.fs.readText('/home/agent/sub/a.txt'), missing };
  },
  async watch({ paths, recursive }) {
    await client.fs.mkdir(paths[0]);
    await client.fs.watch(paths, { recursive }, (change) =>
      postMessage({ event: 'changed', change })
    );
    return true;
  },
  close: ({ kill }) => client.close({ kill }),
};

addEventListener('message', async ({ data }) => {
  try {
    postMessage({ id: data.id, result: await actions[data.action](data) });
  } catch (error) {
    postMessage({ id: data.id, error: `${error.name}: ${error.message}` });
  }
});
