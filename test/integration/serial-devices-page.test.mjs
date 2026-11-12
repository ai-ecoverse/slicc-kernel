import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('serial nodes through the page relay: stat, stty, a loopback, removal', async (t) => {
  const { page, bash } = await booted(chrome, t, { devices: true, network: false });
  await page.evaluate(() => window.kernel.groups.add('dialout', { gid: 20 }));
  await page.evaluate(() =>
    window.addDevice({ path: 'ttyUSB0', group: 'dialout', mode: 0o640, links: ['usb-a_b-if00'] })
  );
  const listed = await bash(
    'ls -l /dev/ttyUSB0 | cut -d" " -f1-6; readlink /dev/serial/by-id/usb-a_b-if00',
    { cwd: '/tmp' }
  );
  assert.equal(listed.stdout, 'crw-r----- 1 root dialout 188, 0\n../../ttyUSB0\n', listed.stderr);
  const loop = await bash(
    'stty -F /dev/ttyUSB0 115200 raw -echo; exec 3<>/dev/ttyUSB0; printf hello >&3; IFS= read -r -t 10 -N 5 got <&3; echo "$got"',
    { cwd: '/tmp' }
  );
  assert.equal(loop.stdout, 'hello\n', loop.stderr);
  const blocked = bash('cat /dev/ttyUSB0; echo "cat $?"', { cwd: '/tmp' });
  await page.until(() => window.devices.ports.length === 3);
  await page.evaluate(() => window.removeDevice('ttyUSB0'));
  const gone = await blocked;
  assert.equal(gone.stdout, 'cat 1\n');
  assert.match(gone.stderr, /Input\/output error|I\/O error/);
  const unlocked = await page.evaluate(() =>
    window.devices.calls.filter((c) => c.op === 'close').map((c) => c.unlocked === true)
  );
  assert.deepEqual(unlocked, [true, true, true]);
  const calls = await page.evaluate(() => window.devices.calls.map((c) => c.op));
  assert.deepEqual(calls, [
    'open',
    'configure',
    'close',
    'open',
    'configure',
    'close',
    'open',
    'configure',
    'close',
  ]);
});

test('an attached client and a bound port answer their own serial nodes', async (t) => {
  const { page } = await booted(chrome, t, { devices: true, network: false });
  const r = await page.evaluate(
    (s) => window.attachedDevice(s),
    'for d in ttyACM0 ttyACM1; do exec 3<>/dev/$d; printf $d >&3; IFS= read -r -t 10 -N 7 got <&3; echo "$got"; exec 3<&-; done'
  );
  assert.equal(r.stdout, 'ttyACM0\nttyACM1\n', JSON.stringify(r));
  const opens = await page.evaluate(() =>
    window.devices.calls.filter((c) => c.op === 'open').map((c) => [c.page, c.path])
  );
  assert.deepEqual(opens, [
    ['tab', '/dev/ttyACM0'],
    ['agent', '/dev/ttyACM1'],
  ]);
});
