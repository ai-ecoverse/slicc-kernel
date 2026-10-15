import { parentPort } from 'node:worker_threads';
import { type DriverStart, hostDriver } from './mount/host.ts';
import { nodeLockdown } from './node-lockdown.ts';

parentPort?.once('message', (start: DriverStart) => {
  nodeLockdown();
  void hostDriver(
    start,
    (code) => import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  );
});
