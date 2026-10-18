const key = new URL(self.location.href).searchParams.get('k') ?? 'kernel';
const counts = {};
const ms = {};
const add = (name, n = 1) => {
  counts[name] = (counts[name] ?? 0) + n;
};
const took = (name, t0) => {
  ms[name] = (ms[name] ?? 0) + (performance.now() - t0);
};

const transaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
  const name = `idb ${mode ?? 'readonly'}`;
  add(name);
  const t0 = performance.now();
  const tx = transaction.call(this, stores, mode, ...rest);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    took(name, t0);
  };
  tx.addEventListener('complete', end);
  tx.addEventListener('abort', end);
  tx.addEventListener('error', end);
  return tx;
};

const family = (name) => String(name).split(':')[0];

if (self.navigator?.locks) {
  const request = LockManager.prototype.request;
  LockManager.prototype.request = function (name, ...rest) {
    const label = `lock ${family(name)}`;
    add(label);
    const t0 = performance.now();
    const options = rest.length > 1 ? rest[0] : undefined;
    const callback = rest.at(-1);
    const timed = (lock) => {
      took(label, t0);
      if (options?.ifAvailable && !lock) add(`${label} unavailable`);
      return callback(lock);
    };
    return options === undefined
      ? request.call(this, name, timed)
      : request.call(this, name, options, timed);
  };
}

const Channel = BroadcastChannel;
const post = Channel.prototype.postMessage;
Channel.prototype.postMessage = function (data) {
  if (this.name !== 'second-tab-count') add(`post ${this.name}`);
  return post.call(this, data);
};
self.BroadcastChannel = class extends Channel {
  constructor(name) {
    super(name);
    if (name !== 'second-tab-count') this.addEventListener('message', () => add(`heard ${name}`));
  }
};

const asyncApi = (proto, label, names) => {
  for (const name of names) {
    const real = proto[name];
    if (typeof real !== 'function') continue;
    proto[name] = function (...args) {
      const what = `opfs ${label}.${name}`;
      add(what);
      const t0 = performance.now();
      const p = real.apply(this, args);
      return p.then(
        (v) => {
          took(what, t0);
          return v;
        },
        (e) => {
          took(what, t0);
          add(`${what} failed`);
          throw e;
        }
      );
    };
  }
};
asyncApi(FileSystemDirectoryHandle.prototype, 'dir', [
  'getFileHandle',
  'getDirectoryHandle',
  'removeEntry',
  'resolve',
]);
asyncApi(FileSystemFileHandle.prototype, 'file', [
  'getFile',
  'createWritable',
  'createSyncAccessHandle',
]);
asyncApi(FileSystemHandle.prototype, 'handle', ['move', 'remove']);

const control = new Channel('second-tab-count');
control.addEventListener('message', ({ data }) => {
  if (data.to !== key) return;
  if (data.reset) {
    for (const k of Object.keys(counts)) delete counts[k];
    for (const k of Object.keys(ms)) delete ms[k];
  }
  const round = Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v)]));
  post.call(control, { from: key, id: data.id, counts: { ...counts }, ms: round });
});
