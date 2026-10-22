import '/dist/kernel-worker.js';

const MOVE_TRIES = 6;
let moves = Number(new URL(import.meta.url).searchParams.get('fail') ?? 0) * MOVE_TRIES;
const UNLINKED = '.slicc-unlinked';
const refuse = () => Promise.reject(new DOMException('injected', 'NoModificationAllowedError'));
const move = FileSystemFileHandle.prototype.move;
FileSystemFileHandle.prototype.move = function (dir, ...rest) {
  if (dir?.name === UNLINKED && moves > 0) {
    moves--;
    return refuse();
  }
  return move.call(this, dir, ...rest);
};
