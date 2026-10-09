export interface CdpConnection {
  send(message: string): void;
  onmessage: ((message: string) => void) | null;
  onclose: ((reason?: string) => void) | null;
  close(): void;
}

export interface CdpRequest {
  runtime?: string;
}

export type CdpHook = (request: CdpRequest) => Promise<CdpConnection>;

export const CDP_PORT = 9222;

export const NO_CDP_HOST =
  'slicc-kernel: no CDP host is attached (createKernel({ cdp }) or client.serveCdp)';
