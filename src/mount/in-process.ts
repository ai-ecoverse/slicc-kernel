import { type MakePortPair, messageChannel } from '../ports.ts';
import { type FilesystemHandlers, type ServedFilesystem, serveFilesystem } from './driver.ts';
import type { MountSpec, OpenedDriver } from './mount-fs.ts';
import type { DriverCapabilities } from './protocol.ts';

export const IN_PROCESS_DRIVER: unique symbol = Symbol.for(
  'slicc-kernel.mount.in-process'
) as never;

export interface InProcessDriver {
  handlers: FilesystemHandlers;
  capabilities?: DriverCapabilities;
  served?(served: ServedFilesystem): void;
}

export type InProcessMountSpec = MountSpec & { [IN_PROCESS_DRIVER]?: InProcessDriver };

export function inProcessMount(spec: MountSpec, driver: InProcessDriver): InProcessMountSpec {
  return { ...spec, [IN_PROCESS_DRIVER]: driver };
}

export function openInProcess(
  spec: MountSpec,
  ports: MakePortPair = messageChannel
): OpenedDriver | undefined {
  const driver = (spec as InProcessMountSpec)[IN_PROCESS_DRIVER];
  if (!driver) return undefined;
  const { port1, port2 } = ports();
  const served = serveFilesystem(port2, driver.handlers, driver.capabilities ?? {}, {
    owned: true,
  });
  driver.served?.(served);
  return {
    port: port1,
    dispose: () => {
      port1.close();
      port2.close();
    },
  };
}
