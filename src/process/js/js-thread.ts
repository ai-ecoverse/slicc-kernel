import {
  JS_THREAD_CRASHED,
  JS_THREAD_NO_MEMORY,
  JS_THREAD_SPAWN,
  type JsThreadControl,
  type JsThreadSpawnMsg,
  type JsThreadStart,
} from '../../kernel/protocol.ts';
import type { SabPostLike } from '../../realm/sync-sab-bridge.ts';
import { JsCallError } from './js-kernel.ts';

export interface JsThread {
  readonly tid: number;
  readonly port: MessagePort;
  readonly exited: Promise<number>;
  terminate(): Promise<void>;
}

export interface JsThreadSpawnOptions {
  data?: unknown;
  transfer?: readonly Transferable[];
}

export interface JsThreadContext {
  readonly tid: number;
  readonly port: MessagePort | undefined;
  readonly data: unknown;
  readonly NO_MEMORY: number;
  readonly CRASHED: number;
  spawn(options?: JsThreadSpawnOptions): Promise<JsThread>;
}

const NativeChannel = globalThis.MessageChannel;

const OOM = /out of memory|Array buffer allocation failed|Cannot allocate Wasm memory/i;

export function outOfMemory(err: unknown): boolean {
  return err instanceof RangeError && OOM.test(err.message);
}

function optionsOf(options: unknown): JsThreadSpawnOptions {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new JsCallError('EINVAL', 'thread.spawn');
  }
  const { transfer } = options as JsThreadSpawnOptions;
  if (transfer !== undefined && !Array.isArray(transfer)) {
    throw new JsCallError('EINVAL', 'thread.spawn');
  }
  return options as JsThreadSpawnOptions;
}

function started(port: MessagePort, control: MessagePort): Promise<JsThread> {
  const exited = Promise.withResolvers<number>();
  return new Promise<JsThread>((resolve, reject) => {
    const thread = (tid: number): JsThread =>
      Object.freeze({
        tid,
        port,
        exited: exited.promise,
        async terminate() {
          control.postMessage({ terminate: true });
          await exited.promise;
        },
      });
    control.onmessage = (event: MessageEvent) => {
      const said = event.data as JsThreadControl;
      if ('tid' in said) resolve(thread(said.tid));
      else if ('errno' in said) {
        control.close();
        port.close();
        reject(new JsCallError(said.errno, 'thread.spawn', said.message));
      } else if ('exited' in said) {
        control.close();
        exited.resolve(said.exited);
      }
    };
  });
}

export function threadContext(post: SabPostLike, start?: JsThreadStart): JsThreadContext {
  const spawn = (options?: JsThreadSpawnOptions): Promise<JsThread> => {
    let asked: JsThreadSpawnOptions;
    try {
      asked = optionsOf(options);
    } catch (err) {
      return Promise.reject(err);
    }
    const channel = new NativeChannel();
    const control = new NativeChannel();
    const transfer = [...(asked.transfer ?? [])];
    const msg: JsThreadSpawnMsg = {
      type: JS_THREAD_SPAWN,
      data: asked.data,
      port: channel.port2,
      control: control.port2,
      transfer,
    };
    try {
      post.postMessage(msg, [channel.port2, control.port2, ...transfer]);
    } catch (err) {
      channel.port1.close();
      control.port1.close();
      return Promise.reject(err);
    }
    return started(channel.port1, control.port1);
  };
  return Object.freeze({
    tid: start?.tid ?? 0,
    port: start?.port,
    data: start?.data,
    NO_MEMORY: JS_THREAD_NO_MEMORY,
    CRASHED: JS_THREAD_CRASHED,
    spawn,
  });
}
