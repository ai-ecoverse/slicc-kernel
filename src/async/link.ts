export interface KernelLink {
  post(message: unknown, transfer?: Transferable[]): void;
  call(message: unknown, transfer?: Transferable[]): Promise<unknown>;
  onMessage(handler: (message: unknown) => void): void;
}

export interface ProcessLink {
  post(message: unknown, transfer?: Transferable[]): void;
  onPost(handler: (message: unknown) => void): void;
  onCall(handler: (message: unknown) => Promise<unknown>): void;
  close(): void;
}
