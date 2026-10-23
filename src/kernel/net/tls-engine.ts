type TlsExport =
  | 'malloc'
  | 'free'
  | 'tls_last_error'
  | 'tls_strerror'
  | 'tls_leaf_new'
  | 'tls_leaf_spki'
  | 'tls_leaf_add_cert'
  | 'tls_leaf_free'
  | 'tls_session_new'
  | 'tls_feed'
  | 'tls_feed_eof'
  | 'tls_in_room'
  | 'tls_read'
  | 'tls_write'
  | 'tls_out_size'
  | 'tls_out_take'
  | 'tls_close'
  | 'tls_alpn_http11'
  | 'tls_session_free';

interface TlsNamedModule {
  _tls_client_new_name(
    store: number,
    name: number,
    nameLen: number,
    alpn: number,
    alpnLen: number,
    flags: number
  ): number;
}

type TlsClientExport =
  | 'tls_ca_new'
  | 'tls_ca_add_der'
  | 'tls_ca_add_bundle'
  | 'tls_ca_free'
  | 'tls_client_new'
  | 'tls_handshake'
  | 'tls_verify_result'
  | 'tls_verify_info'
  | 'tls_alpn'
  | 'tls_version'
  | 'tls_peer_count'
  | 'tls_peer_der';

type TlsSessionExport =
  | 'tls_leaf_import'
  | 'tls_server_new'
  | 'tls_sni'
  | 'tls_client_cert'
  | 'tls_ciphersuite'
  | 'tls_name_mismatch'
  | 'tls_last_alert'
  | 'tls_chain_verify';

export type TlsEngineModule = { readonly HEAPU8: Uint8Array } & {
  readonly [K in TlsExport as `_${K}`]: (...args: number[]) => number;
} & {
  readonly [K in TlsClientExport as `_${K}`]?: (...args: number[]) => number;
} & {
  readonly [K in TlsSessionExport as `_${K}`]?: (...args: number[]) => number;
};

type TlsClientModule = TlsEngineModule & {
  readonly [K in TlsClientExport as `_${K}`]: (...args: number[]) => number;
};

export const TLS_CLIENT_INSECURE_SKIP_VERIFY = 1;
export const TLS_CLIENT_NO_SNI = 2;
export const TLS_CLIENT_VERIFY_CHAIN_ONLY = 4;
export const TLS_SERVER_REQUEST_CERT = 1;
export const TLS_SERVER_REQUIRE_CERT = 2;

const SCRATCH = 64 * 1024;
const EOF = -1;
export class TlsError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
export class TlsEngine {
  private readonly m: TlsEngineModule;
  private readonly scratch: number;
  constructor(m: TlsEngineModule) {
    this.m = m;
    this.scratch = m._malloc(SCRATCH);
    if (!this.scratch) throw new Error('tls engine: out of memory');
  }
  private put(bytes: Uint8Array): number {
    const ptr = this.m._malloc(bytes.length + 1);
    if (!ptr) throw new Error('tls engine: out of memory');
    this.m.HEAPU8.set(bytes, ptr);
    this.m.HEAPU8[ptr + bytes.length] = 0;
    return ptr;
  }
  private taken(n: number): Uint8Array {
    return this.m.HEAPU8.slice(this.scratch, this.scratch + n);
  }
  error(code: number, what: string): TlsError {
    this.m._tls_strerror(code, this.scratch, 256);
    const end = this.m.HEAPU8.indexOf(0, this.scratch);
    const text = new TextDecoder().decode(this.m.HEAPU8.subarray(this.scratch, end));
    return new TlsError(code, `${what}: ${text || code}`);
  }
  leaf(): TlsLeaf {
    const ptr = this.m._tls_leaf_new();
    if (!ptr) throw this.error(this.m._tls_last_error(), 'leaf key');
    return new TlsLeaf(this, this.m, ptr);
  }
  session(leaf: TlsLeaf, host: string): TlsSession {
    const name = this.put(new TextEncoder().encode(host));
    try {
      const ptr = this.m._tls_session_new(leaf.ptr, name);
      if (!ptr) throw this.error(this.m._tls_last_error(), 'tls session');
      return new TlsSession(this, this.m, ptr);
    } finally {
      this.m._free(name);
    }
  }
  get serverSessions(): boolean {
    return typeof this.m._tls_server_new === 'function';
  }
  importLeaf(chain: Uint8Array, key: Uint8Array, pass: Uint8Array): TlsLeaf {
    const leafImport = this.m._tls_leaf_import as (...args: number[]) => number;
    const keyLen = key[0] === 0x2d ? key.length + 1 : key.length;
    const ptr = this.withBytes(chain, (c) =>
      this.withSecret(key, (k) =>
        this.withSecret(pass, (p) =>
          leafImport(c, chain.length, k, keyLen, pass.length > 0 ? p : 0, pass.length)
        )
      )
    );
    if (!ptr) throw this.error(this.m._tls_last_error(), 'server certificate');
    return new TlsLeaf(this, this.m, ptr);
  }
  serverSession(
    leaf: TlsLeaf,
    alpn: readonly string[],
    clientCa: TlsStore | undefined,
    flags: number
  ): TlsSession {
    const open = this.m._tls_server_new as (...args: number[]) => number;
    const wire = alpnWire(alpn);
    const ptr = this.withBytes(wire, (p) =>
      open(leaf.ptr, wire.length > 0 ? p : 0, wire.length, clientCa?.ptr ?? 0, flags)
    );
    if (!ptr) throw this.error(this.m._tls_last_error(), 'tls server');
    return new TlsSession(this, this.m, ptr);
  }
  withBytes<T>(bytes: Uint8Array, fn: (ptr: number) => T): T {
    const ptr = this.put(bytes);
    try {
      return fn(ptr);
    } finally {
      this.m._free(ptr);
    }
  }
  withSecret<T>(bytes: Uint8Array, fn: (ptr: number) => T): T {
    const ptr = this.put(bytes);
    try {
      return fn(ptr);
    } finally {
      this.m.HEAPU8.fill(0, ptr, ptr + bytes.length + 1);
      this.m._free(ptr);
    }
  }

  intoScratch(fn: (ptr: number, max: number) => number): number | Uint8Array {
    const n = fn(this.scratch, SCRATCH);
    return n > 0 ? this.taken(n) : n;
  }
  get sessionControls(): boolean {
    return typeof this.m._tls_client_cert === 'function';
  }

  get client(): TlsClientModule | undefined {
    return typeof this.m._tls_client_new === 'function' ? (this.m as TlsClientModule) : undefined;
  }
  private clientModule(): TlsClientModule {
    const m = this.client;
    if (!m) throw new TlsError(0, 'tls client: the installed tls engine has no client sessions');
    return m;
  }
  store(): TlsStore {
    const m = this.clientModule();
    const ptr = m._tls_ca_new();
    if (!ptr) throw this.error(m._tls_last_error(), 'trust store');
    return new TlsStore(this, m, ptr);
  }
  clientSession(
    store: TlsStore | undefined,
    servername: string,
    alpn: readonly string[],
    flags: number
  ): TlsSession {
    const m = this.clientModule();
    if (servername.includes('\0')) throw new TlsError(-3, 'tls engine: a server name has no NUL');
    const wire = alpnWire(alpn);
    const bytes = new TextEncoder().encode(servername);
    const name = this.put(bytes);
    try {
      const at = store?.ptr ?? 0;
      const named = (m as Partial<TlsNamedModule>)._tls_client_new_name;
      const ptr = this.withBytes(wire, (p) =>
        named
          ? named(at, name, bytes.length, p, wire.length, flags)
          : m._tls_client_new(at, name, p, wire.length, flags)
      );
      if (!ptr) throw this.error(m._tls_last_error(), 'tls client');
      return new TlsSession(this, m, ptr);
    } finally {
      this.m._free(name);
    }
  }
  get chainVerify(): boolean {
    return typeof this.m._tls_chain_verify === 'function';
  }
  chainFlags(store: TlsStore, chain: readonly Uint8Array[], hostname: string): number | undefined {
    const verify = this.m._tls_chain_verify;
    if (!verify || chain.length === 0) return undefined;
    const joined = new Uint8Array(chain.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const der of chain) {
      joined.set(der, at);
      at += der.length;
    }
    const name = this.put(new TextEncoder().encode(hostname));
    try {
      return this.withBytes(joined, (p) => {
        const out = this.scratch;
        this.m.HEAPU8.fill(0xff, out, out + 4);
        const ret = verify(store.ptr, p, joined.length, name, out);
        const flags = new DataView(this.m.HEAPU8.buffer, out, 4).getUint32(0, true);
        if (ret === 0) return flags === 0 ? 0 : undefined;
        return ret === 1 && flags !== 0 ? flags : undefined;
      });
    } finally {
      this.m._free(name);
    }
  }
  verifyInfo(flags: number): string {
    const m = this.clientModule();
    const n = m._tls_verify_info(flags, this.scratch, SCRATCH);
    const end = this.m.HEAPU8.indexOf(0, this.scratch);
    const text = new TextDecoder().decode(this.m.HEAPU8.subarray(this.scratch, end));
    return n < 0 ? `${text}…` : text;
  }
}

function alpnWire(names: readonly string[]): Uint8Array {
  const parts = names.map((name) => new TextEncoder().encode(name));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let at = 0;
  for (const part of parts) {
    out[at++] = part.length;
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export class TlsStore {
  private readonly engine: TlsEngine;
  private readonly m: TlsClientModule;
  readonly ptr: number;
  constructor(engine: TlsEngine, m: TlsClientModule, ptr: number) {
    this.engine = engine;
    this.m = m;
    this.ptr = ptr;
  }
  add(der: Uint8Array): void {
    const ret = this.engine.withBytes(der, (p) => this.m._tls_ca_add_der(this.ptr, p, der.length));
    if (ret !== 0) throw this.engine.error(ret, 'trust store certificate');
  }
  addBundle(bytes: Uint8Array): number {
    const n = this.engine.withBytes(bytes, (p) =>
      this.m._tls_ca_add_bundle(this.ptr, p, bytes.length)
    );
    if (n < 0) throw this.engine.error(n, 'trust store bundle');
    return n;
  }
  release(): void {
    this.m._tls_ca_free(this.ptr);
  }
}
export class TlsLeaf {
  private readonly engine: TlsEngine;
  private readonly m: TlsEngineModule;
  readonly ptr: number;
  constructor(engine: TlsEngine, m: TlsEngineModule, ptr: number) {
    this.engine = engine;
    this.m = m;
    this.ptr = ptr;
  }
  spki(): Uint8Array {
    const out = this.engine.intoScratch((ptr, max) => this.m._tls_leaf_spki(this.ptr, ptr, max));
    if (typeof out === 'number') throw this.engine.error(out, 'leaf public key');
    return out;
  }
  addCert(der: Uint8Array): void {
    const ret = this.engine.withBytes(der, (ptr) =>
      this.m._tls_leaf_add_cert(this.ptr, ptr, der.length)
    );
    if (ret !== 0) throw this.engine.error(ret, 'leaf certificate');
  }
  release(): void {
    this.m._tls_leaf_free(this.ptr);
  }
}
export class TlsSession {
  private readonly engine: TlsEngine;
  private readonly m: TlsEngineModule;
  private readonly ptr: number;
  constructor(engine: TlsEngine, m: TlsEngineModule, ptr: number) {
    this.engine = engine;
    this.m = m;
    this.ptr = ptr;
  }
  feed(bytes: Uint8Array): number {
    return this.engine.withBytes(bytes, (ptr) => this.m._tls_feed(this.ptr, ptr, bytes.length));
  }
  feedEnd(): void {
    this.m._tls_feed_eof(this.ptr);
  }
  read(): Uint8Array | 'more' | 'eof' {
    const out = this.engine.intoScratch((ptr, max) => this.m._tls_read(this.ptr, ptr, max));
    if (out instanceof Uint8Array) return out;
    if (out === 0) return 'more';
    if (out === EOF) return 'eof';
    throw this.engine.error(out, 'tls');
  }
  write(bytes: Uint8Array): number {
    const n = this.engine.withBytes(bytes, (ptr) => this.m._tls_write(this.ptr, ptr, bytes.length));
    if (n < 0) throw this.engine.error(n, 'tls');
    return n;
  }
  take(): Uint8Array {
    if (this.m._tls_out_size(this.ptr) === 0) return new Uint8Array(0);
    const out = this.engine.intoScratch((ptr, max) => this.m._tls_out_take(this.ptr, ptr, max));
    return out instanceof Uint8Array ? out : new Uint8Array(0);
  }
  close(): void {
    this.m._tls_close(this.ptr);
  }
  free(): void {
    this.m._tls_session_free(this.ptr);
  }
  private get c(): TlsClientModule {
    return this.m as TlsClientModule;
  }
  handshake(): boolean {
    const ret = this.c._tls_handshake(this.ptr);
    if (ret < 0) throw this.engine.error(ret, 'tls handshake');
    return ret === 1;
  }
  get verifyResult(): number {
    return this.c._tls_verify_result(this.ptr);
  }
  get version(): number {
    return this.c._tls_version(this.ptr);
  }
  get sni(): string {
    const out = this.engine.intoScratch((p, max) =>
      (this.m._tls_sni as (...a: number[]) => number)(this.ptr, p, max)
    );
    return out instanceof Uint8Array ? new TextDecoder().decode(out) : '';
  }
  get alpn(): string | undefined {
    const out = this.engine.intoScratch((p, max) => this.c._tls_alpn(this.ptr, p, max));
    return out instanceof Uint8Array ? new TextDecoder().decode(out) : undefined;
  }
  ownCert(chain: Uint8Array, key: Uint8Array, pass: Uint8Array): void {
    const set = this.m._tls_client_cert as (...args: number[]) => number;
    const keyLen = key[0] === 0x2d ? key.length + 1 : key.length;
    const ret = this.engine.withBytes(chain, (c) =>
      this.engine.withSecret(key, (k) =>
        this.engine.withSecret(pass, (p) =>
          set(this.ptr, c, chain.length, k, keyLen, pass.length > 0 ? p : 0, pass.length)
        )
      )
    );
    if (ret !== 0) throw this.engine.error(ret, 'client certificate');
  }

  get ciphersuite(): number {
    return (this.m._tls_ciphersuite as (s: number) => number)(this.ptr);
  }

  get lastAlert(): number {
    const last = this.m._tls_last_alert;
    return last ? last(this.ptr) : -1;
  }

  get nameMismatch(): boolean {
    return (this.m._tls_name_mismatch as (s: number) => number)(this.ptr) === 1;
  }

  peerChain(): Uint8Array[] {
    const chain: Uint8Array[] = [];
    const count = this.c._tls_peer_count(this.ptr);
    for (let i = 0; i < count; i++) {
      const der = this.engine.intoScratch((p, max) => this.c._tls_peer_der(this.ptr, i, p, max));
      if (der instanceof Uint8Array) chain.push(der);
    }
    return chain;
  }
}
const loading = new WeakMap<() => Promise<TlsEngineModule>, Promise<TlsEngine>>();
export function loadTlsEngine(load: () => Promise<TlsEngineModule>): Promise<TlsEngine> {
  let engine = loading.get(load);
  if (!engine) {
    const started = load().then((m) => new TlsEngine(m));
    engine = started;
    loading.set(load, started);
    started.catch(() => {
      if (loading.get(load) === started) loading.delete(load);
    });
  }
  return engine;
}
