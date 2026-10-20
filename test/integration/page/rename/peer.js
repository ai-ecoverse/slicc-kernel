const state = { noticeDelay: 0, old: new URL(self.location.href).searchParams.has('old') };
const control = new BroadcastChannel('rename-peer-control');
control.onmessage = ({ data }) => {
  if (!data?.set) return;
  Object.assign(state, data.set);
  control.postMessage({ done: data.id });
};
const watching = (channel) => channel.name.endsWith(':watch');
const post = BroadcastChannel.prototype.postMessage;
BroadcastChannel.prototype.postMessage = function (data) {
  if (watching(this) && state.old && data?.renames) {
    const { renames: _, ...rest } = data;
    return post.call(this, rest);
  }
  return post.call(this, data);
};
const handler = Object.getOwnPropertyDescriptor(BroadcastChannel.prototype, 'onmessage');
Object.defineProperty(BroadcastChannel.prototype, 'onmessage', {
  ...handler,
  set(listener) {
    handler.set.call(this, (event) => {
      const touched = [...(event.data?.paths ?? []), ...(event.data?.trees ?? [])];
      if (
        state.old &&
        this.name.startsWith('slicc-kernel-meta:') &&
        touched.some((path) => String(path).startsWith('/.slicc-renames'))
      )
        return undefined;
      if (watching(this) && event.data?.renaming) {
        if (state.old) return undefined;
        if (state.noticeDelay > 0) {
          setTimeout(() => listener.call(this, event), state.noticeDelay);
          return undefined;
        }
      }
      return listener.call(this, event);
    });
  },
});
