const id = new URL(self.location.href).searchParams.get('id') ?? '';
const control = new BroadcastChannel('pause-control');
const state = { pause: undefined, watch: undefined, held: [], freeze: false, frozen: [] };
control.onmessage = ({ data }) => {
  if (data?.id !== id) return;
  if (data.set) Object.assign(state, data.set);
  if (data.release) for (const go of state.held.splice(0)) go();
  if (data.thaw) {
    state.freeze = false;
    for (const go of state.frozen.splice(0)) go();
  }
  control.postMessage({ id, done: data.seq });
};
const get = IDBObjectStore.prototype.get;
const asked = new WeakMap();
IDBObjectStore.prototype.get = function (key) {
  const keys = asked.get(this.transaction) ?? [];
  keys.push(key);
  asked.set(this.transaction, keys);
  return get.call(this, key);
};
const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
  ...complete,
  set(listener) {
    complete.set.call(this, (event) => {
      const path = state.pause;
      if (
        path !== undefined &&
        this.mode === 'readonly' &&
        (asked.get(this) ?? []).includes(path)
      ) {
        state.pause = undefined;
        state.held.push(() => listener.call(this, event));
        control.postMessage({ id, held: path });
        return undefined;
      }
      return listener.call(this, event);
    });
  },
});
const handler = Object.getOwnPropertyDescriptor(BroadcastChannel.prototype, 'onmessage');
Object.defineProperty(BroadcastChannel.prototype, 'onmessage', {
  ...handler,
  set(listener) {
    handler.set.call(this, (event) => {
      if (state.freeze && this.name !== 'pause-control') {
        state.frozen.push(() => listener.call(this, event));
        return undefined;
      }
      const out = listener.call(this, event);
      const touched = [
        ...(event.data?.paths ?? []),
        ...(event.data?.trees ?? []),
        ...(event.data?.changed ?? []),
      ];
      if (state.watch !== undefined && touched.includes(state.watch)) {
        control.postMessage({ id, seen: state.watch });
      }
      return out;
    });
  },
});
