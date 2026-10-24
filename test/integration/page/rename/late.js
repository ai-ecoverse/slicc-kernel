const state = { late: 0 };
const control = new BroadcastChannel('late-notice-control');
control.onmessage = ({ data }) => {
  if (!data?.set) return;
  Object.assign(state, data.set);
  control.postMessage({ done: data.id });
};
const handler = Object.getOwnPropertyDescriptor(BroadcastChannel.prototype, 'onmessage');
Object.defineProperty(BroadcastChannel.prototype, 'onmessage', {
  ...handler,
  set(listener) {
    handler.set.call(this, (event) => {
      const data = event.data;
      const notice =
        (this.name.endsWith(':watch') && data?.changed !== undefined) ||
        (this.name.startsWith('slicc-kernel-meta:') && (data?.paths || data?.trees));
      if (state.late > 0 && notice) {
        setTimeout(() => listener.call(this, event), state.late);
        return undefined;
      }
      return listener.call(this, event);
    });
  },
});
