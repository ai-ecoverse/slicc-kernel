const post = BroadcastChannel.prototype.postMessage;
const muted = new Set(['slicc-kernel-dirs:slicc-kernel', 'slicc-kernel-meta:slicc-kernel']);
BroadcastChannel.prototype.postMessage = function (data) {
  if (muted.has(this.name)) return;
  if (this.name === 'slicc-kernel-dirs:slicc-kernel:watch' && data?.changed) return;
  post.call(this, data);
};
