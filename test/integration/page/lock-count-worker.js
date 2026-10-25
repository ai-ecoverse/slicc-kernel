import '/dist/kernel-worker.js';

const counts = new BroadcastChannel('lock-count');
let taken = 0;
const request = navigator.locks.request.bind(navigator.locks);
navigator.locks.request = (name, ...rest) => {
  if (String(name).startsWith('slicc-append:')) taken++;
  return request(name, ...rest);
};
counts.onmessage = () => counts.postMessage({ taken });
