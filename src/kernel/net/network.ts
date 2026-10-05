import type { KernelFs } from '../../fs/types.ts';
import type { LoopbackNet } from '../socket.ts';
import { REALM_PROXY_PORT, RealmProxy } from './proxy-service.ts';
import {
  type CaRecord,
  type CaStore,
  indexedDbCaStore,
  type RealmCa,
  realmCa,
} from './realm-ca.ts';
import { loadTlsEngine, type TlsEngine, type TlsEngineModule } from './tls-engine.ts';
import { TlsTerminator } from './tls-tunnel.ts';
import type { RealmTransport } from './transport.ts';

export const NO_TRANSPORT =
  'slicc-kernel: no network transport (createKernel({ network: { transport } }))';

export const TLS_ENGINE_PACKAGE = '@ai-ecoverse/wasm-tls-engine';

export const CA_PATH = '/etc/ssl/certs/slicc-kernel-ca.pem';

const PROXY_URL = `http://127.0.0.1:${REALM_PROXY_PORT}`;

const NO_PROXY = 'localhost,.localhost,127.0.0.1,127.0.0.0/8';

const CA_OWNER = 'slicc-kernel';

export function networkEnv(): Record<string, string> {
  return {
    http_proxy: PROXY_URL,
    https_proxy: PROXY_URL,
    HTTP_PROXY: PROXY_URL,
    HTTPS_PROXY: PROXY_URL,
    no_proxy: NO_PROXY,
    NO_PROXY: NO_PROXY,
    SSL_CERT_FILE: CA_PATH,
    CURL_CA_BUNDLE: CA_PATH,
    GIT_SSL_CAINFO: CA_PATH,
  };
}

export function missingTransport(): RealmTransport {
  return {
    traits: { manualRedirects: true, encodedBodies: true, maxRequestBody: 0 },
    fetch: () => Promise.reject(Object.assign(new Error(NO_TRANSPORT), { status: 502 })),
  };
}

export function memoryCaStore(): CaStore {
  const records = new Map<string, CaRecord>();
  return {
    get: async (owner) => records.get(owner),
    put: async (owner, record) => {
      records.set(owner, record);
    },
  };
}

export function caStore(metadata: string | false): CaStore {
  return metadata === false ? memoryCaStore() : indexedDbCaStore(`${metadata}-ca`);
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

export function packageTlsEngine(fs: KernelFs, modules: string): () => Promise<TlsEngineModule> {
  const dir = `${modules.replace(/\/+$/, '')}/${TLS_ENGINE_PACKAGE}/dist`;
  return async () => {
    let glue: Uint8Array;
    let wasmBinary: Uint8Array;
    try {
      [glue, wasmBinary] = await Promise.all([
        fs.readFileBuffer(`${dir}/slicc-tls-engine.mjs`),
        fs.readFileBuffer(`${dir}/slicc-tls-engine.wasm`),
      ]);
    } catch {
      throw new Error(`TLS needs ${TLS_ENGINE_PACKAGE} installed in ${modules}`);
    }
    const url = `data:text/javascript;base64,${base64(glue)}`;
    const factory = (await import(url)) as {
      default: (options: {
        wasmBinary: Uint8Array;
        locateFile: (path: string) => string;
      }) => Promise<TlsEngineModule>;
    };
    return factory.default({ wasmBinary, locateFile: (path) => path });
  };
}

export interface NetworkOptions {
  transport?: RealmTransport;
  engine: () => Promise<TlsEngine>;
  ca: () => Promise<RealmCa>;
  now?: () => number;
}

export function kernelCa(store: CaStore): () => Promise<RealmCa> {
  return () => realmCa(CA_OWNER, store);
}

export function kernelTlsEngine(load: () => Promise<TlsEngineModule>): () => Promise<TlsEngine> {
  return () => loadTlsEngine(load);
}

export async function writeCaFile(fs: KernelFs, ca: () => Promise<RealmCa>): Promise<void> {
  const { pem } = await ca();
  const current = (await fs.exists(CA_PATH)) ? await fs.readFile(CA_PATH) : undefined;
  if (current === pem) return;
  await fs.mkdir(CA_PATH.slice(0, CA_PATH.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(CA_PATH, pem);
}

export function enableNetwork(
  net: LoopbackNet,
  options: NetworkOptions
): () => RealmProxy | undefined {
  let proxy: RealmProxy | undefined;
  const transport = options.transport ?? missingTransport();
  net.activate({ family: 'inet', host: '127.0.0.1', port: REALM_PROXY_PORT }, () => {
    const tls = new TlsTerminator({
      ca: options.ca,
      engine: options.engine,
      ...(options.now ? { now: options.now } : {}),
    });
    const started = new RealmProxy({
      net,
      transport,
      tunnel: tls.handler,
      tunnelReady: async () => {
        await options.engine();
      },
    });
    proxy = started;
    void started.closed.then(async () => {
      if (proxy === started) proxy = undefined;
      await tls.close();
    });
  });
  return () => proxy;
}
