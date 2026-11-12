import { DurableObject } from 'cloudflare:workers';
import {
  cloudflareProcesses,
  Images,
  IsolateGate,
  PROCESS_HOST_SOURCE,
} from '../../../../dist/cloudflare.js';
import { KernelRoutes } from './kernel-routes.js';
import TEST_PROCESS from './test-process.js';

class Fake {
  constructor(pid) {
    this.pid = pid;
    this.events = [];
    this.commands = [];
    this.wanting = undefined;
    this.reading = undefined;
    this.feeds = [];
    this.sys = 0;
  }

  next() {
    const cmd = this.commands.shift();
    if (cmd) return Promise.resolve(cmd);
    return new Promise((resolve) => {
      this.wanting = resolve;
    });
  }

  command(cmd) {
    const want = this.wanting;
    this.wanting = undefined;
    if (want) want(cmd);
    else this.commands.push(cmd);
  }

  read() {
    const data = this.feeds.shift();
    if (data !== undefined) return Promise.resolve(data);
    this.events.push({ type: 'read-blocked' });
    return new Promise((resolve) => {
      this.reading = resolve;
    });
  }

  feed(data) {
    const reading = this.reading;
    this.reading = undefined;
    if (reading) reading(data);
    else this.feeds.push(data);
  }

  async call(message) {
    if (message.op === 'sys') {
      this.sys++;
      return message.i + 1;
    }
    if (message.op === 'next') return this.next();
    if (message.op === 'read') return this.read();
    if (message.op === 'big') {
      this.events.push({
        type: 'big-in',
        size: message.bytes.byteLength,
        last: message.bytes.at(-1),
      });
      return { bytes: new Uint8Array(message.bytes.byteLength + 5).fill(9) };
    }
    throw new Error(`unknown op ${message.op}`);
  }
}

const json = (value, status = 200) => Response.json(value, { status });

export class Plumbing extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.images = new Images();
    this.gate = new IsolateGate(8, 3000);
    this.processes = cloudflareProcesses(env.LOADER, this.images, this.gate, {
      host: PROCESS_HOST_SOURCE,
      process: TEST_PROCESS,
    });
    this.fakes = new Map();
    this.links = new Map();
    this.nextPid = 1;
    this.kernelRoutes = new KernelRoutes(env);
  }

  spawn(image) {
    const pid = this.nextPid++;
    const fake = new Fake(pid);
    this.fakes.set(pid, fake);
    const started = Date.now();
    this.processes.open({ type: 'init', program: { image } }).then(
      (link) => {
        this.links.set(pid, link);
        fake.events.push({ type: 'opened', ms: Date.now() - started });
        link.onPost((message) => fake.events.push(message));
        link.onClose((reason) => fake.events.push({ type: 'closed', reason }));
        link.onCall((message) => fake.call(message));
        link.post({ type: 'init', pid });
      },
      (err) => fake.events.push({ type: 'failed', code: err?.code, message: String(err?.message) })
    );
    return pid;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;
    const args =
      body && url.pathname !== '/image' ? JSON.parse(new TextDecoder().decode(body)) : {};
    if (url.pathname.startsWith('/kernel/')) return this.kernelRoutes.handle(url.pathname, args);
    const fake = this.fakes.get(args.pid ?? Number(url.searchParams.get('pid')));
    switch (url.pathname) {
      case '/image':
        return json(await this.images.register(new Uint8Array(body)));
      case '/spawn':
        return json({ pid: this.spawn(args.image) });
      case '/cmd':
        fake.command(args.cmd);
        return json({ ok: true });
      case '/feed':
        fake.feed(args.data);
        return json({ ok: true });
      case '/signal':
        this.links.get(args.pid).post({ type: 'signal', sig: args.sig });
        return json({ ok: true });
      case '/terminate':
        this.links.get(args.pid).close();
        return json({ ok: true });
      case '/events':
        return json({ events: fake.events, sys: fake.sys });
      case '/gate':
        return json({
          active: this.gate.active,
          peak: this.gate.peak,
          loads: this.processes.loads,
        });
      default:
        return json({ error: 'unknown route' }, 404);
    }
  }
}

export default {
  fetch(request, env) {
    if (request.headers.get('x-slicc-key') !== env.KEY)
      return new Response('forbidden', { status: 403 });
    const name = new URL(request.url).searchParams.get('do') ?? 'main';
    return env.PLUMBING.get(env.PLUMBING.idFromName(name)).fetch(request);
  },
};
