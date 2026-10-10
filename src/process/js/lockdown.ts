export const BLOCKED_GLOBALS: readonly string[] = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'WebTransport',
  'EventSource',
  'importScripts',
  'indexedDB',
  'caches',
  'cookieStore',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'postMessage',
  'close',
];

export const BLOCKED_NAVIGATOR: readonly string[] = ['storage', 'locks', 'serviceWorker'];

function chain(target: object): object[] {
  const out: object[] = [];
  for (let at: object | null = target; at && at !== Object.prototype; ) {
    out.push(at);
    at = Object.getPrototypeOf(at);
  }
  return out;
}

function hide(target: object, names: readonly string[]): void {
  for (const name of names) {
    const holders = chain(target);
    for (const holder of holders) {
      if (Object.getOwnPropertyDescriptor(holder, name)?.configurable) {
        Reflect.deleteProperty(holder, name);
      }
    }
    const kept = holders.slice(1).some((holder) => Object.hasOwn(holder, name));
    const defined = Reflect.defineProperty(target, name, {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    if (kept || (!defined && Reflect.get(target, name) !== undefined)) {
      throw new Error(`slicc-kernel: cannot withhold ${name} from a JS program`);
    }
  }
}

export function lockdown(scope: object = globalThis): void {
  hide(scope, BLOCKED_GLOBALS);
  const navigator = (scope as { navigator?: unknown }).navigator;
  if (navigator && typeof navigator === 'object') hide(navigator, BLOCKED_NAVIGATOR);
}
