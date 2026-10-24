const params = new URL(self.location.href).searchParams;
const state = {
  noticeDelay: 0,
  old: params.has('old'),
  deaf: params.has('deaf'),
  holdsOnly: params.has('holds-only'),
};
const control = new BroadcastChannel('rename-peer-control');
control.onmessage = ({ data }) => {
  if (data?.get !== undefined) {
    control.postMessage({ done: data.id, value: state[data.get] });
    return;
  }
  if (!data?.set) return;
  Object.assign(state, data.set);
  control.postMessage({ done: data.id });
};
const watching = (channel) => channel.name.endsWith(':watch');
const post = BroadcastChannel.prototype.postMessage;
let me;
BroadcastChannel.prototype.postMessage = function (data) {
  if (watching(this) && data?.hello !== undefined) me = data.hello;
  if (watching(this) && state.holdsOnly && data?.holds?.instance !== undefined) {
    const { instance: _, ...holds } = data.holds;
    return post.call(this, { ...data, holds });
  }
  if (watching(this) && state.old && (data?.renames || data?.keeps)) {
    const { renames: _, keeps: __, ...rest } = data;
    return post.call(this, rest);
  }
  return post.call(this, data);
};
const handler = Object.getOwnPropertyDescriptor(BroadcastChannel.prototype, 'onmessage');
Object.defineProperty(BroadcastChannel.prototype, 'onmessage', {
  ...handler,
  set(listener) {
    handler.set.call(this, (event) => {
      if (
        state.old &&
        watching(this) &&
        (event.data?.holds || event.data?.keeping || event.data?.kept)
      )
        return undefined;
      if (state.holdsOnly && watching(this) && (event.data?.keeping || event.data?.kept)) {
        state.keepAsks = (state.keepAsks ?? 0) + 1;
        return undefined;
      }
      const missing = state.old || state.deaf;
      const touched = [...(event.data?.paths ?? []), ...(event.data?.trees ?? [])];
      if (
        missing &&
        this.name.startsWith('slicc-kernel-meta:') &&
        touched.some((path) => String(path).startsWith('/.slicc-renames'))
      )
        return undefined;
      if (watching(this) && event.data?.renaming) {
        if (state.deaf && me !== undefined) {
          post.call(this, { ack: event.data.seq, from: me, to: event.data.tab });
          return undefined;
        }
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
