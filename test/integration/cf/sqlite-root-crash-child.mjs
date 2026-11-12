import { sqlStorage } from './sqlite-root-adapter.mjs';
import { bash, sqliteKernel } from './sqlite-root-helpers.mjs';

const [path] = process.argv.slice(2);
const sql = sqlStorage(path);
const kernel = await sqliteKernel(sql);
const loop = [
  'mkdir -p /root/work',
  '(while true; do head -c 3000000 /dev/zero > /root/work/big.tmp && mv /root/work/big.tmp /root/work/big; done) &',
  'i=0',
  'while true; do i=$((i+1)); mkdir -p /root/work/d$i; echo $i > /root/work/d$i/f; mv /root/work/d$i/f /root/work/d$i/g; ln -s g /root/work/d$i/l; chmod 600 /root/work/d$i/g; if [ $i = 3 ]; then echo started; fi; done',
].join('\n');
await bash(kernel, loop, {
  onStdout: (text) => {
    if (String(text).includes('started')) process.stdout.write('started\n');
  },
});
