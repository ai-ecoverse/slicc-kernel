import { type DialledSocket, type DialOptions, errorWithCode } from './dial-stream.ts';

export interface LoopbackFetchOptions extends DialOptions {
  signal?: AbortSignal;
}

const OWN_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);
const encoder = new TextEncoder();
const latin1 = new TextDecoder('latin1');

class ByteSource {
  private buffered = new Uint8Array(0);
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  private async more(): Promise<boolean> {
    const { done, value } = await this.reader.read();
    if (done) return false;
    const joined = new Uint8Array(this.buffered.length + value.length);
    joined.set(this.buffered);
    joined.set(value, this.buffered.length);
    this.buffered = joined;
    return true;
  }

  async until(marker: string): Promise<Uint8Array | undefined> {
    const needle = encoder.encode(marker);
    for (;;) {
      const at = indexOf(this.buffered, needle);
      if (at >= 0) return this.take(at + needle.length);
      if (!(await this.more())) return undefined;
    }
  }

  async some(max: number): Promise<Uint8Array | undefined> {
    if (this.buffered.length === 0 && !(await this.more())) return undefined;
    return this.take(Math.min(max, this.buffered.length));
  }

  async exactly(count: number): Promise<Uint8Array | undefined> {
    while (this.buffered.length < count) if (!(await this.more())) return undefined;
    return this.take(count);
  }

  private take(count: number): Uint8Array {
    const out = this.buffered.slice(0, count);
    this.buffered = this.buffered.slice(count);
    return out;
  }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

interface ResponseHead {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
}

function parseHead(bytes: Uint8Array): ResponseHead {
  const [statusLine = '', ...lines] = latin1.decode(bytes).split('\r\n');
  const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!match) throw errorWithCode(`EPROTO: not an HTTP/1.x response: ${statusLine.slice(0, 80)}`);
  const headers: Array<[string, string]> = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return { status: Number(match[1]), statusText: match[2] ?? '', headers };
}

function header(head: ResponseHead, name: string): string | undefined {
  return head.headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

async function* chunked(source: ByteSource): AsyncGenerator<Uint8Array> {
  for (;;) {
    const line = await source.until('\r\n');
    if (!line) throw errorWithCode('EPROTO: the chunked body ended early');
    const size = Number.parseInt(latin1.decode(line).trim().split(';')[0] ?? '', 16);
    if (!Number.isFinite(size)) throw errorWithCode('EPROTO: a malformed chunk size');
    if (size === 0) return;
    const data = await source.exactly(size);
    if (!data || !(await source.exactly(2))) throw errorWithCode('EPROTO: a chunk ended early');
    yield data;
  }
}

async function* counted(source: ByteSource, length: number): AsyncGenerator<Uint8Array> {
  let left = length;
  while (left > 0) {
    const data = await source.some(left);
    if (!data) throw errorWithCode('EPROTO: the body ended early');
    left -= data.length;
    yield data;
  }
}

async function* untilClose(source: ByteSource): AsyncGenerator<Uint8Array> {
  for (let data = await source.some(65536); data; data = await source.some(65536)) yield data;
}

function bodyOf(source: ByteSource, head: ResponseHead, method: string) {
  if (method === 'HEAD' || head.status === 204 || head.status === 304) return undefined;
  if (header(head, 'transfer-encoding')?.toLowerCase().includes('chunked')) return chunked(source);
  const length = header(head, 'content-length');
  return length !== undefined ? counted(source, Number(length)) : untilClose(source);
}

function stream(chunks: AsyncGenerator<Uint8Array>, socket: DialledSocket) {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) {
          controller.close();
          socket.close();
        } else controller.enqueue(next.value);
      } catch (err) {
        controller.error(err);
        socket.close();
      }
    },
    cancel() {
      socket.close();
    },
  });
}

async function requestBytes(request: Request): Promise<Uint8Array> {
  const url = new URL(request.url);
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  const lines = [`${request.method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`];
  request.headers.forEach((value, name) => {
    if (!OWN_HEADERS.has(name)) lines.push(`${name}: ${value}`);
  });
  if (body) lines.push(`Content-Length: ${body.length}`);
  lines.push('Connection: close', '', '');
  const head = encoder.encode(lines.join('\r\n'));
  const out = new Uint8Array(head.length + (body?.length ?? 0));
  out.set(head);
  if (body) out.set(body, head.length);
  return out;
}

export async function loopbackFetch(
  dial: (options: DialOptions) => Promise<DialledSocket>,
  input: RequestInfo | URL,
  options: LoopbackFetchOptions
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input);
  const bytes = await requestBytes(request);
  const socket = await dial({
    port: options.port,
    ...(options.host ? { host: options.host } : {}),
  });
  options.signal?.addEventListener('abort', () => socket.close(), { once: true });
  try {
    const writer = socket.writable.getWriter();
    await writer.write(bytes);
    writer.releaseLock();
    const source = new ByteSource(socket.readable.getReader());
    let head: ResponseHead;
    do {
      const raw = await source.until('\r\n\r\n');
      if (!raw) throw errorWithCode('ECONNRESET: the connection closed before a response');
      head = parseHead(raw);
    } while (head.status >= 100 && head.status < 200);
    const chunks = bodyOf(source, head, request.method);
    if (!chunks) socket.close();
    return new Response(chunks ? stream(chunks, socket) : null, {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
    });
  } catch (err) {
    socket.close();
    throw err;
  }
}
