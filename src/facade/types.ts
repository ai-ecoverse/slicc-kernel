import type { ConnectorStamp } from '../kernel/socket.ts';

export interface FacadeConnection {
  send(bytes: Uint8Array): void;
  onmessage: ((bytes: Uint8Array) => void) | null;
  onclose: ((reason?: string) => void) | null;
  close(): void;
}

export interface FacadeInfo {
  name: string;
}

export type FacadeHook = (
  stamp: ConnectorStamp,
  info: FacadeInfo
) => FacadeConnection | Promise<FacadeConnection>;

export interface FacadeSpec {
  port: number;
  hook?: FacadeHook;
}

export type FacadeSpecs = Readonly<Record<string, FacadeSpec>>;

export interface FacadeOpenRequest {
  name: string;
  stamp: ConnectorStamp;
}

export const FACADE_NAME = /^[a-z][a-z0-9-]*$/;

export function facadeEnvName(name: string): string {
  return `SLICC_${name.toUpperCase().replaceAll('-', '_')}_URL`;
}

export function facadeUrl(port: number): string {
  return `tcp://127.0.0.1:${port}`;
}
