const channel = new BroadcastChannel('swap-pause');
let armed = false;
let release;
globalThis[Symbol.for('slicc-kernel.test.syscall')] = async ({ op }) => {
  if (!armed || op !== 'proc-umask') return;
  armed = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  channel.postMessage('paused');
  await gate;
};
channel.onmessage = ({ data }) => {
  if (data === 'arm') {
    armed = true;
    channel.postMessage('armed');
  }
  if (data === 'release') release?.();
};
