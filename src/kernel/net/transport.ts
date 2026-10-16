export type HeaderList = ReadonlyArray<readonly [name: string, value: string]>;
export interface RealmTransportRequest {
  url: string;
  method: string;
  headers: HeaderList;
  body?: Uint8Array;
  bodyStream?: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
}
export interface RealmRedirectHop {
  status: number;
  url: string;
  headers: HeaderList;
}
export interface RealmTransportResponse {
  url?: string;
  redirected?: boolean;
  redirects?: readonly RealmRedirectHop[];
  status: number;
  statusText: string;
  headers: HeaderList;
  body: AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
}
export interface RealmTransportExit {
  kind: 'local' | 'remote' | 'tailnet' | (string & {});
  caps: readonly string[];
  [detail: string]: unknown;
}
export interface RealmTransportTraits {
  manualRedirects: boolean;
  encodedBodies: boolean;
  maxRequestBody: number;
  crossOrigin?: 'cors' | 'any';
  unavailable?: true;
  websocket?: true;
  streamingBodies?: true;
  redirectHops?: true;
  exit?: RealmTransportExit;
  [trait: string]: unknown;
}
export interface RealmWebSocketRequest {
  url: string;
  protocols: string[];
  headers: HeaderList;
  signal: AbortSignal;
}
export interface RealmWebSocketClose {
  code: number;
  reason: string;
  wasClean?: boolean;
}
export type RealmWebSocketMessage = string | Uint8Array;
export interface RealmWebSocket {
  readonly protocol: string;
  readonly buffered: number;
  send(data: RealmWebSocketMessage): void;
  readonly messages: AsyncIterable<RealmWebSocketMessage>;
  close(code?: number, reason?: string): void;
  readonly closed: Promise<RealmWebSocketClose>;
}
export interface RealmTransport {
  readonly traits: RealmTransportTraits;
  fetch(request: RealmTransportRequest, owner?: number): Promise<RealmTransportResponse>;
  websocket?(request: RealmWebSocketRequest): Promise<RealmWebSocket>;
}
