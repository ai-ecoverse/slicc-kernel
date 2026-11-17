import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const probe = new URL('./fixtures/ttyprobe/', import.meta.url);
const TIMEOUT = { timeout: 180_000 };
const encoder = new TextEncoder();

async function installDir(kernel, dir, at) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${at}/${relative(dir, file)}`, await readFile(file));
  }
}

function fakeDevices(name = 'page', start = {}) {
  const calls = [];
  const ports = [];
  const hook = {
    open(request) {
      calls.push({ op: 'open', page: name, path: request.path, flags: request.flags });
      calls.at(-1).uid = request.stamp.uid;
      let controller;
      const port = {
        written: [],
        loop: start.loop ?? true,
        held: start.held ? Promise.withResolvers() : undefined,
        push: (text) => controller.enqueue(encoder.encode(text)),
        end: () => controller.close(),
        fail: (message) => controller.error(new Error(message)),
        hold() {
          port.held = Promise.withResolvers();
        },
        release() {
          port.held?.resolve();
          port.held = undefined;
        },
      };
      const readable = new ReadableStream(
        {
          start: (c) => {
            controller = c;
          },
        },
        { highWaterMark: 0 }
      );
      const writable = new WritableStream({
        async write(chunk) {
          if (port.held) await port.held.promise;
          port.written.push(...chunk);
          if (port.loop) controller.enqueue(chunk.slice());
        },
      });
      ports.push(port);
      return {
        readable,
        writable,
        control(op, args) {
          calls.push({ op, ...(args ? { args } : {}) });
          if (op === 'close') calls.at(-1).locked = [readable.locked, writable.locked];
          if (op === 'signals')
            return {
              clearToSend: true,
              dataCarrierDetect: true,
              dataSetReady: false,
              ringIndicator: false,
            };
          return undefined;
        },
      };
    },
  };
  const ops = (op) => calls.filter((c) => c.op === op);
  return { hook, calls, ports, ops, start };
}

async function booted(t, options = {}, packages = ['wasm-bash', 'wasm-coreutils'], start = {}) {
  const devices = fakeDevices('page', start);
  const denials = [];
  const kernel = await createNodeKernel({
    users: 'enforce',
    devices: devices.hook,
    onDenial: (d) => denials.push(d),
    approve: () => 'once',
    ...options,
  });
  t.after(() => kernel.terminate());
  for (const name of packages) {
    await installDir(
      kernel,
      fileURLToPath(new URL(`${name}/`, modules)),
      `/node_modules/@ai-ecoverse/${name}`
    );
  }
  await installDir(kernel, fileURLToPath(probe), '/node_modules/ttyprobe');
  await kernel.groups.add('dialout', { gid: 20 });
  const bash = (script, o = {}) => kernel.run(['bash', '-c', script], { cwd: '/tmp', ...o });
  return { kernel, bash, devices, denials };
}

const until = async (what, check) => {
  const end = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test(
  'a node stats as a character device with its owner, mode and major, and its by-id link resolves',
  TIMEOUT,
  async (t) => {
    const { kernel, bash } = await booted(t);
    await kernel.devices.add({
      path: 'ttyUSB0',
      owner: 0,
      group: 'dialout',
      mode: 0o640,
      links: ['usb-0403_6001-if00'],
    });
    await kernel.devices.add({ path: '/dev/ttyACM2', group: 20, mode: 0o660 });
    const r = await bash(
      'ls -l /dev/ttyUSB0 | cut -d" " -f1-6; stat -c "%t %T %a %U %G %F" /dev/ttyUSB0 /dev/ttyACM2; readlink /dev/serial/by-id/usb-0403_6001-if00; ls /dev/serial/by-id; ls /dev | tr "\\n" " "'
    );
    assert.equal(r.stderr, '');
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], 'crw-r----- 1 root dialout 188, 0');
    assert.equal(lines[1], 'bc 0 640 root dialout character special file');
    assert.equal(lines[2], 'a6 2 660 root dialout character special file');
    assert.equal(lines[3], '../../ttyUSB0');
    assert.equal(lines[4], 'usb-0403_6001-if00');
    assert.match(lines[5], / serial .*ttyACM2 ttyUSB0 /);
    const refused = await bash(
      'rm /dev/ttyUSB0; ln -s /dev/ttyUSB0 /dev/serial/by-id/x; echo "$?"'
    );
    assert.match(refused.stderr, /cannot remove '\/dev\/ttyUSB0': Operation not permitted/);
    assert.equal(refused.stdout, '1\n');
  }
);

test(
  'kernel.devices.add refuses bad names, owners, links and clients, and duplicates',
  TIMEOUT,
  async (t) => {
    const { kernel } = await booted(t, {}, []);
    await kernel.devices.add({ path: 'ttyUSB0', links: ['one'] });
    const plain = await kernel.connect();
    const cases = [
      [{ path: 'ttyUSB0' }, 'EEXIST'],
      [{ path: 'ttyUSB1', links: ['one'] }, 'EEXIST'],
      [{ path: 'ttyUSB1', links: ['a', 'a'] }, 'EEXIST'],
      [{ path: 'ttyS0' }, 'EINVAL'],
      [{ path: 'ttyUSB256' }, 'EINVAL'],
      [{ path: 'ttyUSB1', mode: 0o10000 }, 'EINVAL'],
      [{ path: 'ttyUSB1', owner: 'nobody-here' }, 'EINVAL'],
      [{ path: 'ttyUSB1', group: -1 }, 'EINVAL'],
      [{ path: 'ttyUSB1', links: ['a/b'] }, 'EINVAL'],
      [{ path: 'ttyUSB1', links: 'a' }, 'EINVAL'],
      [{ path: 'ttyUSB1', client: {} }, 'EINVAL'],
      [{ path: 'ttyUSB1', client: plain }, 'ENOTSUP'],
    ];
    for (const [spec, code] of cases) {
      await assert.rejects(kernel.devices.add(spec), { code }, JSON.stringify(spec));
    }
    const bare = await createNodeKernel({ users: 'enforce' });
    t.after(() => bare.terminate());
    await assert.rejects(bare.devices.add({ path: 'ttyUSB0' }), { code: 'ENOTSUP' });
    await assert.rejects(createNodeKernel({ devices: {} }), TypeError);
  }
);

test(
  'a dialout member reads a 0640 node, O_RDWR as that member is EACCES and reported, sudo opens it',
  TIMEOUT,
  async (t) => {
    const { kernel, bash, devices, denials } = await booted(t);
    await kernel.users.add({ name: 'cone', groups: ['dialout', 'sudo'] });
    await kernel.users.add({ name: 'bob' });
    await kernel.devices.add({ path: 'ttyUSB0', owner: 0, group: 'dialout', mode: 0o640 });
    const reading = bash('head -c 6 /dev/ttyUSB0; echo " $?"', { user: 'cone' });
    await until('the open', () => devices.ports.length === 1);
    devices.ports[0].push('hello\n');
    assert.deepEqual(await reading, { status: 0, stdout: 'hello\n 0\n', stderr: '' });
    const rdwr = await bash('exec 3<>/dev/ttyUSB0; echo "rc=$?"', { user: 'cone' });
    assert.equal(rdwr.stdout, 'rc=1\n');
    assert.match(rdwr.stderr, /Permission denied/);
    const outsider = await bash('cat /dev/ttyUSB0; echo "rc=$?"', { user: 'bob' });
    assert.match(outsider.stderr, /Permission denied/);
    assert.deepEqual(
      denials.filter((d) => d.path === '/dev/ttyUSB0').map((d) => [d.op, d.uid, d.errno]),
      [
        ['open', 1000, 'EACCES'],
        ['open', 1001, 'EACCES'],
      ]
    );
    const sudo = await bash('sudo bash -c "printf x > /dev/ttyUSB0"; echo "rc=$?"', {
      user: 'cone',
    });
    assert.equal(sudo.stdout, 'rc=0\n', sudo.stderr);
    assert.deepEqual(
      devices.ops('open').map((c) => [c.flags, c.uid]),
      [
        [0, 1000],
        [1, 0],
      ]
    );
    assert.deepEqual(devices.ports[1].written, [0x78]);
  }
);

test(
  'a second open of a node is EBUSY until the first is closed everywhere',
  TIMEOUT,
  async (t) => {
    const { kernel, bash, devices } = await booted(t);
    await kernel.devices.add({ path: 'ttyACM0', links: ['usb-2e8a_0005-if00'] });
    const r = await bash(
      'exec 3<>/dev/ttyACM0; exec 4</dev/serial/by-id/usb-2e8a_0005-if00; echo "second $?"; ( exec 5</dev/ttyACM0; echo "child $?" ); exec 3<&-; exec 4</dev/ttyACM0; echo "again $?"'
    );
    assert.equal(r.stdout, 'second 1\nchild 1\nagain 0\n');
    assert.match(r.stderr, /Resource busy/);
    assert.deepEqual(
      devices.calls.map((c) => c.op),
      ['open', 'close', 'open', 'close']
    );
    assert.deepEqual(
      devices.ops('close').map((c) => c.locked),
      [
        [false, false],
        [false, false],
      ]
    );
  }
);

test(
  'remove() while a read is blocked hangs the reader up with EIO and takes the link along',
  TIMEOUT,
  async (t) => {
    const { kernel, bash, devices } = await booted(t);
    const node = await kernel.devices.add({ path: 'ttyUSB0', links: ['gone'] });
    const blocked = bash('cat /dev/ttyUSB0; echo "cat $?"');
    await until('the open', () => devices.ports.length === 1);
    await new Promise((r) => setTimeout(r, 300));
    await node.remove();
    const r = await blocked;
    assert.equal(r.stdout, 'cat 1\n');
    assert.match(r.stderr, /cat: \/dev\/ttyUSB0: Input\/output error|I\/O error/);
    const after = await bash('ls /dev/ttyUSB0 /dev/serial/by-id/gone 2>&1; echo "rc=$?"');
    assert.match(after.stdout, /cannot access '\/dev\/ttyUSB0'/);
    assert.match(after.stdout, /cannot access '\/dev\/serial\/by-id\/gone'/);
    await node.remove();
    assert.equal(devices.ops('close').length, 1);
  }
);

test(
  'the end of the readable is a hangup: a reader sees end of file, then a write is EIO',
  TIMEOUT,
  async (t) => {
    const { kernel, bash, devices } = await booted(t);
    await kernel.devices.add({ path: 'ttyUSB0' });
    const r = bash('exec 3<>/dev/ttyUSB0; cat <&3; echo "cat $?"; printf x >&3; echo "write $?"');
    await until('the open', () => devices.ports.length === 1);
    devices.ports[0].loop = false;
    devices.ports[0].push('last words');
    devices.ports[0].end();
    const done = await r;
    assert.equal(done.stdout, 'last wordscat 0\nwrite 1\n');
    assert.match(done.stderr, /Input\/output error|I\/O error/);
  }
);

test(
  'stty sets the speed, size and parity with one configure call, which the next open keeps',
  TIMEOUT,
  async (t) => {
    const { kernel, bash, devices } = await booted(t);
    await kernel.devices.add({ path: 'ttyUSB0' });
    const first = await bash(
      'stty -F /dev/ttyUSB0 -a | head -1; stty -F /dev/ttyUSB0 | tail -n +2'
    );
    assert.equal(
      first.stdout,
      'speed 9600 baud; rows 0; columns 0; line = 0;\nmin = 1; time = 0;\n-brkint -icrnl -imaxbel\n-opost\n-isig -icanon -iexten -echo\n'
    );
    assert.deepEqual(devices.ops('configure'), []);
    const set = await bash(
      'stty -F /dev/ttyUSB0 115200 cs8 -parenb raw; echo "rc=$?"; stty -F /dev/ttyUSB0 | head -1'
    );
    assert.equal(set.stdout, 'rc=0\nspeed 115200 baud; line = 0;\n', set.stderr);
    assert.deepEqual(devices.ops('configure'), [
      {
        op: 'configure',
        args: { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' },
      },
      {
        op: 'configure',
        args: { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' },
      },
    ]);
    await bash('stty -F /dev/ttyUSB0 19200 cs7 parenb parodd cstopb crtscts');
    assert.deepEqual(devices.ops('configure').at(-1).args, {
      baudRate: 19200,
      dataBits: 7,
      parity: 'odd',
      stopBits: 2,
      flowControl: 'hardware',
    });
  }
);

test(
  'a custom speed through TCSETS2 and BOTHER from a WASIX program, and the defaults at the first open',
  TIMEOUT,
  async (t) => {
    const { kernel, devices } = await booted(t);
    await kernel.devices.add({ path: 'ttyUSB0' });
    const r = await kernel.run(['ttyprobe', '/dev/ttyUSB0', 'get2', 'baud', '250000', 'get2'], {
      cwd: '/tmp',
    });
    assert.deepEqual(r, {
      status: 0,
      stdout:
        'ispeed=9600 ospeed=9600 cbaud=15\nbaud set\nispeed=250000 ospeed=250000 cbaud=10000\n',
      stderr: '',
    });
    assert.deepEqual(devices.ops('configure'), [
      {
        op: 'configure',
        args: { baudRate: 250000, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' },
      },
    ]);
  }
);

test(
  'modem lines round trip from a WASIX program: TIOCMGET, TIOCMBIC and TIOCMBIS; TIOCSCTTY is EPERM and others ENOTTY',
  TIMEOUT,
  async (t) => {
    const { kernel, devices } = await booted(t);
    await kernel.devices.add({ path: 'ttyUSB0' });
    const r = await kernel.run(
      [
        'ttyprobe',
        '/dev/ttyUSB0',
        'mget',
        'mbic',
        '0x6',
        'mget',
        'mbis',
        '0x4',
        'mget',
        'ctty',
        'serial',
      ],
      { cwd: '/tmp' }
    );
    assert.equal(
      r.stdout,
      'modem=0x66\nmbic done\nmodem=0x60\nmbis done\nmodem=0x64\nctty errno=63\nserial errno=59\n'
    );
    assert.deepEqual(
      devices.ops('setSignals').map((c) => c.args),
      [
        { dataTerminalReady: false, requestToSend: false },
        { dataTerminalReady: false, requestToSend: true },
      ]
    );
  }
);

test(
  'TCDRAIN waits for the writable side, TCFLSH discards input, and a break toggles the line',
  TIMEOUT,
  async (t) => {
    const { kernel, devices } = await booted(t, {}, ['wasm-bash', 'wasm-coreutils'], {
      held: true,
    });
    await kernel.devices.add({ path: 'ttyUSB0' });
    const lines = [];
    const run = kernel.run(
      [
        'ttyprobe',
        '/dev/ttyUSB0',
        'write',
        'one',
        'drain',
        'fionread',
        'flush',
        '0',
        'fionread',
        'break',
      ],
      { cwd: '/tmp', onStdout: (s) => lines.push(...s.split('\n').filter(Boolean)) }
    );
    await until('the write', () => lines.length === 1);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(lines, ['wrote 3']);
    assert.deepEqual(devices.ports[0].written, []);
    devices.ports[0].release();
    const r = await run;
    assert.equal(r.stdout, 'wrote 3\ndrained\nfionread=3\nflushed\nfionread=0\nbreak sent\n');
    assert.deepEqual(
      devices.calls.filter((c) => c.op === 'flush' || c.op === 'setSignals').map((c) => c.args),
      [{ input: true, output: false }, { break: true }, { break: false }]
    );
  }
);

test(
  'a raw read and write loop from Emscripten programs, with a wakeup when bytes arrive',
  TIMEOUT,
  async (t) => {
    const { kernel, bash, devices } = await booted(t);
    await kernel.devices.add({ path: 'ttyUSB0' });
    const echo = await bash(
      'exec 3<>/dev/ttyUSB0; stty raw -echo <&3; for w in alpha beta; do printf "$w" >&3; IFS= read -r -t 5 -N ${#w} got <&3; echo "$got"; done'
    );
    assert.deepEqual(echo, { status: 0, stdout: 'alpha\nbeta\n', stderr: '' });
    const r = bash('exec 3<>/dev/ttyUSB0; IFS= read -r -t 10 -N 5 got <&3; echo "got $got"');
    await until('the open', () => devices.ports.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    devices.ports[1].push('later');
    assert.equal((await r).stdout, 'got later\n');
    devices.start.loop = false;
    const cooked = bash(
      'exec 3<>/dev/ttyUSB0; stty icanon echo icrnl onlcr opost <&3; printf ready >&3; IFS= read -r -t 10 line <&3; echo "line $line"'
    );
    await until('the third open', () => devices.ports.length === 3);
    const port = devices.ports[2];
    await until('ready', () => Buffer.from(port.written).toString() === 'ready');
    port.push('ab\r');
    assert.equal((await cooked).stdout, 'line ab\n');
    assert.equal(Buffer.from(port.written).toString(), 'readyab\r\n');
  }
);

test(
  'O_NONBLOCK reads are EAGAIN, poll wakes when bytes arrive, and backpressure holds a writer',
  TIMEOUT,
  async (t) => {
    const { kernel, devices } = await booted(t, {}, [
      'wasm-bash',
      'wasm-coreutils',
      'wasix-python',
    ]);
    await kernel.devices.add({ path: 'ttyACM0', links: ['usb-2e8a_0005-if00'] });
    const script = [
      'import errno, os, select, termios, time',
      "fd = os.open('/dev/serial/by-id/usb-2e8a_0005-if00', os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)",
      'a = termios.tcgetattr(fd)',
      "print('tty', os.isatty(fd), a[4], a[5], flush=True)",
      'try:',
      '    os.read(fd, 10)',
      'except BlockingIOError as e:',
      "    print('read', errno.errorcode[e.errno], flush=True)",
      'p = select.poll()',
      'p.register(fd, select.POLLIN)',
      "print('ready', flush=True)",
      "print('poll', [(n == fd, e) for n, e in p.poll(10000)], os.read(fd, 10), flush=True)",
      "print('wrote', os.write(fd, b'abc'), flush=True)",
      'try:',
      "    os.write(fd, b'def')",
      'except BlockingIOError as e:',
      "    print('write', errno.errorcode[e.errno], flush=True)",
      'os.set_blocking(fd, True)',
      "print('blocked write', os.write(fd, b'ghi'), flush=True)",
    ].join('\n');
    await kernel.writeFile('/tmp/nb.py', script);
    const out = [];
    const run = kernel.run(['python3', '-u', '/tmp/nb.py'], {
      cwd: '/tmp',
      onStdout: (s) => out.push(s),
    });
    await until('poll', () => out.join('').includes('ready'));
    const port = devices.ports[0];
    port.loop = false;
    await new Promise((r) => setTimeout(r, 300));
    port.hold();
    port.push('wake');
    await until('the first write', () => out.join('').includes('wrote'));
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(out.join(''), /blocked write/);
    port.release();
    const r = await run;
    assert.equal(
      r.stdout,
      "tty True 13 13\nread EAGAIN\nready\npoll [(True, 1)] b'wake'\nwrote 3\nwrite EAGAIN\nblocked write 3\n",
      r.stderr
    );
    assert.equal(Buffer.from(port.written).toString(), 'abcghi');
  }
);

test(
  'a JS program uses the handle methods: termios, modem lines, break, drain and flush',
  TIMEOUT,
  async (t) => {
    const { kernel, devices } = await booted(t, {}, []);
    await kernel.devices.add({ path: 'ttyACM3', links: ['usb-x_y-if00'] });
    await kernel.writeFile(
      '/node_modules/sp/package.json',
      JSON.stringify({ name: 'sp', slicc: { commands: { sp: { abi: 'js', module: 'sp.mjs' } } } })
    );
    await kernel.writeFile(
      '/node_modules/sp/sp.mjs',
      `export default async function main(ctx) {
  const out = (s) => ctx.write(1, s + '\\n');
  await out((await ctx.fs.readdir('/dev')).filter((n) => n === 'serial' || n.startsWith('ttyA')).join(','));
  await out((await ctx.fs.stat('/dev/serial/by-id/usb-x_y-if00')).mode.toString(8) + ' ' + (await ctx.fs.readlink('/dev/serial/by-id/usb-x_y-if00')));
  const h = await ctx.open('/dev/ttyACM3', { read: true, write: true });
  const t = await h.termios();
  await out(t.ospeed + ' ' + t.c_cflag.toString(8));
  await h.setTermios({ ...t, ispeed: 921600, ospeed: 921600 }, 'drain');
  await out(String((await h.termios()).ospeed));
  await h.setModem({ dtr: false });
  await out(JSON.stringify(await h.modem()));
  await h.write(0, new TextEncoder().encode('hey'));
  await h.drain();
  await out(new TextDecoder().decode(await h.read(0, 3)));
  await h.flush('input');
  await h.sendBreak();
  await h.close();
  const s = ctx.sync.open('/dev/serial/by-id/usb-x_y-if00', { read: true });
  await out('sync ' + s.termios().ospeed + ' ' + s.modem().dtr);
  s.flush();
  s.close();
  try {
    await h.modem();
  } catch (e) {
    await out(e.code);
  }
}`
    );
    const r = await kernel.run(['sp'], { cwd: '/tmp' });
    assert.deepEqual(r, {
      status: 0,
      stdout:
        'serial,ttyACM3\n20600 ../../ttyACM3\n9600 6275\n921600\n{"dtr":false,"rts":true,"cts":true,"dsr":false,"cd":true,"ri":false}\nhey\nsync 921600 true\nEBADF\n',
      stderr: '',
    });
    assert.deepEqual(
      devices.ops('configure').map((c) => c.args.baudRate),
      [921600, 921600]
    );
    assert.deepEqual(
      devices.ops('flush').map((c) => c.args),
      [
        { input: true, output: false },
        { input: true, output: true },
      ]
    );
  }
);

test(
  'each node is answered by the hook of the client it was added for: the page, a bound port, an attached client',
  TIMEOUT,
  async (t) => {
    const { kernel, bash, devices } = await booted(t);
    const agent = fakeDevices('agent');
    const tab = fakeDevices('tab');
    const bound = await kernel.connect({ devices: agent.hook });
    const attach = await kernel.connect({ devices: 'attach' });
    const client = await attachKernel(attach, { devices: tab.hook });
    t.after(() => client.close());
    await kernel.devices.add({ path: 'ttyUSB0' });
    await kernel.devices.add({ path: 'ttyUSB1', client: bound });
    await kernel.devices.add({ path: 'ttyACM0', client: attach });
    await assert.rejects(attachKernel(await kernel.connect(), { devices: tab.hook }), /EPERM/);
    const r = await bash(
      'for d in ttyUSB0 ttyUSB1 ttyACM0; do exec 3<>/dev/$d; printf $d >&3; IFS= read -r -t 5 -N 7 got <&3; echo "$got"; exec 3<&-; done'
    );
    assert.equal(r.stdout, 'ttyUSB0\nttyUSB1\nttyACM0\n', r.stderr);
    assert.deepEqual(
      [devices, agent, tab].map((d) => d.ops('open').map((c) => [c.page, c.path])),
      [[['page', '/dev/ttyUSB0']], [['agent', '/dev/ttyUSB1']], [['tab', '/dev/ttyACM0']]]
    );
    client.close();
    const gone = await bash(
      'for i in $(seq 50); do [ -e /dev/ttyACM0 ] || break; sleep 0.1; done; ls /dev/ttyACM0'
    );
    assert.match(gone.stderr, /cannot access '\/dev\/ttyACM0'/);
  }
);

test(
  'a refused open and a signal during a slow open reach the program; the page sees the abort',
  TIMEOUT,
  async (t) => {
    const aborted = [];
    const hook = {
      open(request) {
        if (request.path === '/dev/ttyUSB1')
          throw Object.assign(new Error('the port is gone'), { name: 'NotFoundError' });
        return new Promise((_, reject) =>
          request.signal.addEventListener('abort', () => {
            aborted.push(String(request.signal.reason?.message ?? request.signal.reason));
            reject(request.signal.reason);
          })
        );
      },
    };
    const { kernel, bash } = await booted(t, { devices: hook });
    await kernel.devices.add({ path: 'ttyUSB0' });
    await kernel.devices.add({ path: 'ttyUSB1' });
    const refused = await bash('cat /dev/ttyUSB1; echo "rc=$?"');
    assert.equal(refused.stdout, 'rc=1\n');
    assert.match(refused.stderr, /No such file or directory/);
    const slow = await bash('timeout 1 cat /dev/ttyUSB0; echo "rc=$?"');
    assert.equal(slow.stdout, 'rc=124\n');
    await until('the abort', () => aborted.length === 1);
  }
);

test(
  'B0 keeps the line hung up across opens, and a real speed raises DTR and RTS again',
  TIMEOUT,
  async (t) => {
    const { kernel, bash, devices } = await booted(t);
    await kernel.devices.add({ path: 'ttyUSB0' });
    await bash('stty -F /dev/ttyUSB0 0');
    const reopened = devices.calls.length;
    const r = await kernel.run(['ttyprobe', '/dev/ttyUSB0', 'mget'], { cwd: '/tmp' });
    assert.equal(r.stdout, 'modem=0x60\n');
    const after = devices.calls.slice(reopened);
    assert.deepEqual(
      after.filter((c) => c.op === 'setSignals').map((c) => c.args),
      [{ dataTerminalReady: false, requestToSend: false }]
    );
    assert.deepEqual(
      after.filter((c) => c.op === 'configure'),
      []
    );
    const raised = await kernel.run(
      ['bash', '-c', 'stty -F /dev/ttyUSB0 115200 && ttyprobe /dev/ttyUSB0 mget'],
      {
        cwd: '/tmp',
      }
    );
    assert.equal(raised.stdout, 'modem=0x66\n', raised.stderr);
    assert.deepEqual(devices.ops('setSignals').at(-1).args, {
      dataTerminalReady: true,
      requestToSend: true,
    });
    assert.deepEqual(devices.ops('configure').at(-1).args.baudRate, 115200);
  }
);

test(
  'chmod, chown and touch of a node follow the file rules and show in stat everywhere',
  TIMEOUT,
  async (t) => {
    const { kernel, bash, denials } = await booted(t);
    await kernel.users.add({ name: 'cone', groups: ['dialout'] });
    await kernel.devices.add({ path: 'ttyUSB0', group: 'dialout', mode: 0o640, links: ['l'] });
    const user = await bash(
      'chmod 666 /dev/ttyUSB0; echo "chmod $?"; chown cone /dev/ttyUSB0; echo "chown $?"; touch -d 2001-01-01 /dev/ttyUSB0; echo "touch $?"',
      {
        user: 'cone',
      }
    );
    assert.equal(user.stdout, 'chmod 1\nchown 1\ntouch 1\n');
    assert.match(user.stderr, /Operation not permitted/);
    assert.deepEqual(
      denials.filter((d) => d.path === '/dev/ttyUSB0').map((d) => [d.op, d.errno]),
      [
        ['chmod', 'EPERM'],
        ['chown', 'EPERM'],
        ['open', 'EACCES'],
        ['utimes', 'EPERM'],
      ]
    );
    const root = await bash(
      'chmod 660 /dev/serial/by-id/l && chown cone:root /dev/ttyUSB0 && touch -d "2001-02-03 04:05:06" /dev/ttyUSB0 && stat -c "%a %U %G %y" /dev/ttyUSB0 | cut -c1-33'
    );
    assert.equal(root.stdout, '660 cone root 2001-02-03 04:05:06\n', root.stderr);
    const owner = await bash('chmod 600 /dev/ttyUSB0 && stat -c %a /dev/ttyUSB0', { user: 'cone' });
    assert.equal(owner.stdout, '600\n', owner.stderr);
    await kernel.writeFile(
      '/node_modules/st/package.json',
      JSON.stringify({ name: 'st', slicc: { commands: { st: { abi: 'js', module: 'st.mjs' } } } })
    );
    await kernel.writeFile(
      '/node_modules/st/st.mjs',
      `export default async function main(ctx) {
  const s = await ctx.fs.stat('/dev/ttyUSB0');
  await ctx.write(1, [(s.mode & 0o7777).toString(8), s.uid, s.gid, new Date(s.mtimeMs).getUTCFullYear()].join(' ') + '\\n');
}`
    );
    assert.equal((await kernel.run(['st'], { cwd: '/tmp' })).stdout, '600 1000 0 2001\n');
  }
);

test('touch -m and touch -a of a node keep the omitted time (#1821)', TIMEOUT, async (t) => {
  const { bash, kernel } = await booted(t);
  await kernel.devices.add({ path: 'ttyUSB0', group: 'dialout', mode: 0o640 });
  const r = await bash(
    [
      'touch -d @981173106 /dev/ttyUSB0 /tmp/f',
      'touch -m -d @1104537600 /dev/ttyUSB0 /tmp/f',
      'stat -c "%X %Y" /dev/ttyUSB0 /tmp/f',
      'touch -a -d @1136073600 /dev/ttyUSB0',
      'stat -c "%X %Y" /dev/ttyUSB0',
    ].join(' && ')
  );
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, '981173106 1104537600\n981173106 1104537600\n1136073600 1104537600\n');
});

async function jsCommand(kernel, name, source) {
  await kernel.writeFile(
    `/node_modules/${name}/package.json`,
    JSON.stringify({ name, slicc: { commands: { [name]: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile(`/node_modules/${name}/main.mjs`, source);
}

test(
  'a hook that throws NoModificationAllowedError fails the open with EBUSY in every runtime',
  TIMEOUT,
  async (t) => {
    const held = {
      open() {
        throw Object.assign(new Error('serial1 is open in serial (serial close serial1)'), {
          name: 'NoModificationAllowedError',
        });
      },
    };
    const { kernel, bash } = await booted(t, { devices: held });
    await kernel.devices.add({ path: 'ttyUSB0', mode: 0o600 });
    await jsCommand(
      kernel,
      'jsopen',
      `export default async function main(ctx) {
  for (const open of [() => ctx.open('/dev/ttyUSB0', { read: true }), () => ctx.sync.open('/dev/ttyUSB0', { read: true })]) {
    try {
      await open();
      await ctx.write(1, 'opened\\n');
    } catch (err) {
      await ctx.write(1, err.code + '\\n');
    }
  }
}`
    );
    const r = await bash(
      'cat /dev/ttyUSB0; echo "cat $?"; ttyprobe /dev/ttyUSB0 mget; echo "wasix $?"; jsopen'
    );
    assert.equal(r.stdout, 'cat 1\nwasix 1\nEBUSY\nEBUSY\n');
    assert.match(r.stderr, /^cat: \/dev\/ttyUSB0: (Device or resource|Resource) busy$/m);
    assert.match(r.stderr, /^open: (Device or resource|Resource) busy$/m);
  }
);

const JS_META = `export default async function main(ctx) {
  const [path, mode, uid, gid, atime, mtime] = ctx.argv.slice(1);
  const out = [];
  const step = async (name, call) => {
    try {
      await call();
      out.push(name + ' done');
    } catch (err) {
      out.push(name + ' ' + err.code);
    }
  };
  const sync = ctx.argv[0].endsWith('sync');
  const fs = sync ? ctx.sync.fs : ctx.fs;
  await step('chmod', () => fs.chmod(path, Number.parseInt(mode, 8)));
  await step('chown', () => fs.chown(path, Number(uid), Number(gid)));
  await step('utimes', () => fs.utimes(path, Number(atime), Number(mtime)));
  const s = await ctx.fs.stat(path);
  out.push([(s.mode & 0o7777).toString(8), s.uid, s.gid, s.atimeMs, s.mtimeMs].join(' '));
  await ctx.write(1, out.join('\\n') + '\\n');
}`;

test(
  'chmod, chown and utimes of a node from WASIX and JS programs follow the file rules and show in stat everywhere',
  TIMEOUT,
  async (t) => {
    const { kernel, bash, devices, denials } = await booted(t);
    await kernel.users.add({ name: 'cone', groups: ['dialout'] });
    await kernel.devices.add({ path: 'ttyUSB0', group: 'dialout', mode: 0o640, links: ['l'] });
    await jsCommand(kernel, 'jsmeta', JS_META);
    await jsCommand(kernel, 'jsmetasync', JS_META);
    await bash('ln -s /dev/ttyUSB0 /tmp/x');
    const user = await bash(
      [
        'ttyprobe chmod /dev/ttyUSB0 666',
        'ttyprobe chown /dev/serial/by-id/l 1000 20',
        'ttyprobe utime /tmp/x 100 200',
        'ttyprobe fchmod /dev/ttyUSB0 666',
        'ttyprobe fchown /dev/ttyUSB0 1000 20',
        'ttyprobe futimens /dev/ttyUSB0 300',
        'jsmeta /dev/ttyUSB0 666 1000 20 1000 2000',
        'jsmetasync /tmp/x 666 -1 0 1000 2000',
      ].join('; '),
      { user: 'cone' }
    );
    assert.equal(
      user.stdout,
      [
        'chmod Operation not permitted',
        'chown Operation not permitted',
        'utime Operation not permitted',
        'fchmod Operation not permitted',
        'fchown Operation not permitted',
        'futimens Operation not permitted',
        'chmod EPERM',
        'chown EPERM',
        'utimes EPERM',
        user.stdout.split('\n')[9],
        'chmod EPERM',
        'chown EPERM',
        'utimes EPERM',
        user.stdout.split('\n')[9],
        '',
      ].join('\n'),
      user.stderr
    );
    assert.match(user.stdout.split('\n')[9], /^640 0 20 \d+ \d+$/);
    assert.deepEqual(
      denials.map((d) => [d.op, d.path, d.errno]),
      ['chmod', 'chown', 'utimes', 'chmod', 'chown', 'utimes', 'chmod', 'chown', 'utimes']
        .concat(['chmod', 'chown', 'utimes'])
        .map((op) => [op, '/dev/ttyUSB0', 'EPERM'])
    );
    const root = await bash(
      [
        'ttyprobe chmod /dev/serial/by-id/l 600',
        'ttyprobe chown /tmp/x 1000 20',
        'ttyprobe utime /dev/ttyUSB0 100 200',
        'ttyprobe utime /dev/ttyUSB0 omit 300',
        'stat -c "%a %U %G %X %Y" /dev/ttyUSB0',
        'ttyprobe fchmod /dev/ttyUSB0 660',
        'ttyprobe fchown /dev/ttyUSB0 0 0',
        'ttyprobe futimens /dev/ttyUSB0 400',
        'stat -c "%a %u %g %X %Y" /dev/ttyUSB0',
        'jsmeta /tmp/x 604 1000 20 5000 7000',
        'jsmetasync /dev/serial/by-id/l 640 -1 0 9000 11000',
        'stat -c "%a %u %g %X %Y" /dev/ttyUSB0',
        'ttyprobe stat /dev/ttyUSB0',
      ].join(' && ')
    );
    assert.equal(
      root.stdout,
      [
        'chmod done',
        'chown done',
        'utime done',
        'utime done',
        '600 cone dialout 100 300',
        'fchmod done',
        'fchown done',
        'futimens done',
        '660 0 0 400 400',
        'chmod done',
        'chown done',
        'utimes done',
        '604 1000 20 5000 7000',
        'chmod done',
        'chown done',
        'utimes done',
        '640 1000 0 9000 11000',
        '640 1000 0 9 11',
        'stat mode=20640 uid=1000 gid=0',
        '',
      ].join('\n'),
      root.stderr
    );
    const owner = await bash(
      'ttyprobe chmod /dev/ttyUSB0 600 && ttyprobe utime /dev/ttyUSB0 50 60 && stat -c "%a %X %Y" /dev/ttyUSB0 && jsmeta /dev/ttyUSB0 640 -1 -1 70000 80000',
      { user: 'cone' }
    );
    assert.equal(
      owner.stdout,
      'chmod done\nutime done\n600 50 60\nchmod done\nchown done\nutimes done\n640 1000 0 70000 80000\n',
      owner.stderr
    );
    assert.equal(denials.length, 12);
  }
);

test(
  'a JS program chowns and retimes a regular file under the file rules, and a bad id or time is EINVAL, and /proc is EROFS',
  TIMEOUT,
  async (t) => {
    const { kernel, bash } = await booted(t);
    await kernel.users.add({ name: 'cone' });
    await jsCommand(kernel, 'jsmeta', JS_META);
    await jsCommand(kernel, 'jsmetasync', JS_META);
    await jsCommand(
      kernel,
      'jsbad',
      `export default async function main(ctx) {
  const out = [];
  for (const call of [
    () => ctx.fs.chown('/tmp/f', 1.5, 0),
    () => ctx.fs.chown('/tmp/f', -2, 0),
    () => ctx.fs.chown('/tmp/f', 0, 0xffffffff),
    () => ctx.fs.utimes('/tmp/f', Number.NaN, 0),
    () => ctx.fs.utimes('/tmp/f', 0, '1'),
    () => ctx.sync.fs.chown('/tmp/f', 0, null),
    () => ctx.sync.fs.utimes('/tmp/f', Infinity, 0),
    () => ctx.fs.chown('/tmp/missing', 0, 0),
    () => ctx.sync.fs.utimes('/tmp/missing', 0, 0),
    () => ctx.fs.chown('/proc/self/status', 0, 0),
    () => ctx.sync.fs.utimes('/proc/uptime', 0, 0),
  ]) {
    try {
      await call();
      out.push('done');
    } catch (err) {
      out.push(err.code);
    }
  }
  await ctx.write(1, out.join(' ') + '\\n');
}`
    );
    const root = await bash('echo x > /tmp/f && jsmeta /tmp/f 640 1000 20 5000 7000 && jsbad');
    assert.equal(
      root.stdout,
      'chmod done\nchown done\nutimes done\n640 1000 20 5000 7000\nEINVAL EINVAL EINVAL EINVAL EINVAL EINVAL EINVAL ENOENT ENOENT EROFS EROFS\n',
      root.stderr
    );
    const owner = await bash(
      'jsmetasync /tmp/f 600 0 -1 1000 2000 && stat -c "%a %u %X %Y" /tmp/f',
      {
        user: 'cone',
      }
    );
    assert.equal(
      owner.stdout,
      'chmod done\nchown EPERM\nutimes done\n600 1000 20 1000 2000\n600 1000 1 2\n',
      owner.stderr
    );
  }
);
