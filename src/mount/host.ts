import { attachKernel } from '../client/attach.ts';
import type { MessagePortLike } from '../client/protocol.ts';
import type { RealmTransportRequest, RealmTransportResponse } from '../kernel/net/transport.ts';
import { type FilesystemHandlers, serveFilesystem } from './driver.ts';
import { DRIVER_PROTOCOL, type DriverCapabilities } from './protocol.ts';

export interface DriverStart {
  code: string;
  driver: MessagePortLike;
  client: MessagePortLike;
}

export interface DriverEnv {
  fetch(
    request: Omit<RealmTransportRequest, 'signal'> & { signal?: AbortSignal }
  ): Promise<RealmTransportResponse>;
}

export type DriverFactory = (
  env: DriverEnv
) =>
  | Promise<{ handlers: FilesystemHandlers; capabilities?: DriverCapabilities }>
  | { handlers: FilesystemHandlers; capabilities?: DriverCapabilities };

export async function hostDriver(
  start: DriverStart,
  load: (code: string) => Promise<{ default?: unknown }>
): Promise<void> {
  try {
    const factory = (await load(start.code)).default;
    if (typeof factory !== 'function') {
      throw new Error('a slicc file system module must export a default function');
    }
    const client = await attachKernel(start.client, { locks: null });
    const made = await (factory as DriverFactory)({ fetch: (request) => client.fetch(request) });
    serveFilesystem(start.driver, made.handlers, made.capabilities ?? {});
  } catch (err) {
    start.driver.postMessage({
      hello: {
        protocol: DRIVER_PROTOCOL,
        error: `the driver did not start: ${err instanceof Error ? err.message : String(err)}`,
        errno: 'EIO',
      },
    });
  }
}
