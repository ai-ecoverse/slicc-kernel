import type {
  KernelClient,
  NetworkExit,
  NetworkTraits,
  NetworkTransport,
} from '../../../src/index.ts';

export function exitOf(client: KernelClient): () => void {
  return client.onTraits((traits) => {
    const exit: NetworkExit | undefined = traits.exit;
    const kind: string | undefined = exit?.kind;
    const caps: readonly string[] = exit?.caps ?? [];
    const tray: unknown = traits.tray;
    void [kind, caps, tray];
  });
}

export function withExit(inner: NetworkTransport, exit: NetworkExit | undefined): NetworkTransport {
  return {
    ...inner,
    get traits(): NetworkTraits {
      return { ...inner.traits, ...(exit ? { exit } : {}), tray: { linked: true } };
    },
  };
}

export const tailnet: NetworkExit = {
  kind: 'tailnet',
  caps: ['net', 'http', 'ws'],
  node: 'exit-1',
};
export const later: NetworkExit = { kind: 'satellite', caps: [] };
