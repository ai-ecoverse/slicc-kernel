const counts = new BroadcastChannel('replacing-count');
const taken = [];
const request = navigator.locks.request.bind(navigator.locks);
navigator.locks.request = (name, ...rest) => {
  if (String(name).startsWith('slicc-kernel-replacing:')) taken.push(String(name));
  return request(name, ...rest);
};
counts.onmessage = () => counts.postMessage({ taken });
