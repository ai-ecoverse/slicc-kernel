declare module 'cloudflare:workers' {
  export abstract class RpcTarget {}
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected ctx: { waitUntil(promise: Promise<unknown>): void };
    protected env: Env;
    constructor(ctx: unknown, env: Env);
  }
}

declare module 'slicc:cloudflare-sources' {
  export const HOST_SOURCE: string;
  export const PROCESS_SOURCE: string | undefined;
}

declare module 'slicc:process' {
  export function asyncProcessEntry(
    link: {
      post(message: unknown, transfer?: Transferable[]): void;
      call(message: unknown, transfer?: Transferable[]): Promise<unknown>;
      onMessage(handler: (message: unknown) => void): void;
    },
    deps: {
      module(image: string): WebAssembly.Module | Promise<WebAssembly.Module>;
      snapshots?: unknown;
    }
  ): unknown;
}

declare module 'slicc:program' {
  const program: WebAssembly.Module;
  export default program;
}
