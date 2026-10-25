const blind = new URL(self.location.href).searchParams.get('path');
const handler = Object.getOwnPropertyDescriptor(BroadcastChannel.prototype, 'onmessage');
Object.defineProperty(BroadcastChannel.prototype, 'onmessage', {
  ...handler,
  set(listener) {
    handler.set.call(this, (event) => {
      const data = event.data ?? {};
      const touched = [...(data.paths ?? []), ...(data.trees ?? []), ...(data.changed ?? [])];
      if (touched.includes(blind)) return undefined;
      return listener.call(this, event);
    });
  },
});
