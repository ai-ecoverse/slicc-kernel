import { after, test } from 'node:test';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { launch } from './chrome.mjs';
import { hostFolder } from './mount-host.mjs';

const chrome = await launch();
after(() => chrome.close());

async function sliccNode(dir, origin) {
  let key;
  const start = (port) =>
    startProxy({ port, origins: [origin], mounts: [`${dir}:project`], ...(key ? { key } : {}) });
  let proxy = await start(0);
  key = proxy.key;
  const port = new URL(proxy.url).port;
  return {
    url: proxy.url,
    key: proxy.key,
    stop: () => proxy.close(),
    async start() {
      proxy = await start(Number(port));
    },
    close: () => proxy.close().catch(() => undefined),
  };
}

test('hostfs against slicc-node: the same run against the real local proxy', (t) =>
  hostFolder(chrome, t, (dir) => sliccNode(dir, new URL(chrome.url).origin)));
