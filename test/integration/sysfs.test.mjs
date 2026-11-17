import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { setTestSyscallHook } from '../../dist/testing.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const probe = new URL('./fixtures/ttyprobe/', import.meta.url);
const TIMEOUT = { timeout: 300_000 };

const FTDI = {
  path: 'ttyUSB0',
  group: 'dialout',
  mode: 0o640,
  links: ['usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0'],
  sys: {
    idVendor: 0x0403,
    idProduct: '6001',
    manufacturer: 'FTDI',
    product: 'FT232R USB UART',
    serial: 'A50285BI',
  },
};
const PICO = {
  path: 'ttyACM0',
  group: 'dialout',
  mode: 0o640,
  sys: { idVendor: '2E8A', idProduct: 5 },
};
const BARE = { path: 'ttyUSB3' };

const PORTS = [
  'import glob, os',
  'def line(*parts):',
  '    try:',
  '        with open(os.path.join(*parts)) as f:',
  '            return f.readline().strip()',
  '    except IOError:',
  '        return None',
  "for dev in sorted(glob.glob('/dev/ttyUSB*') + glob.glob('/dev/ttyACM*')):",
  '    name = os.path.basename(dev)',
  "    link = '/sys/class/tty/%s/device' % name",
  '    if not os.path.exists(link):',
  "        print(name, 'none', os.path.exists('/sys/class/tty/%s' % name))",
  '        continue',
  '    device = os.path.realpath(link)',
  "    subsystem = os.path.basename(os.path.realpath(os.path.join(device, 'subsystem')))",
  "    interface = os.path.dirname(device) if subsystem == 'usb-serial' else device",
  '    usb = os.path.dirname(interface)',
  "    vid = int(line(usb, 'idVendor'), 16)",
  "    pid = int(line(usb, 'idProduct'), 16)",
  "    count = int(line(usb, 'bNumInterfaces'))",
  "    print(name, subsystem, os.path.basename(usb), '%04X:%04X' % (vid, pid), count,",
  "          line(interface, 'bInterfaceNumber'), line(usb, 'manufacturer'), line(usb, 'product'),",
  "          line(usb, 'serial'))",
  "print(' '.join(os.listdir('/sys/class/tty')), 'sys' in os.listdir('/'))",
].join('\n');

const WRITES = [
  'import errno, os',
  "for name, step in [('open', lambda: open('/sys/class/tty/ttyUSB0/dev', 'w')),",
  "                   ('mkdir', lambda: os.mkdir('/sys/x')),",
  "                   ('unlink', lambda: os.unlink('/sys/class/tty/ttyUSB0')),",
  "                   ('rename', lambda: os.rename('/sys/bus', '/tmp/bus')),",
  "                   ('symlink', lambda: os.symlink('/tmp', '/sys/l')),",
  "                   ('chmod', lambda: os.chmod('/sys/class/tty/ttyUSB0/dev', 0o600))]:",
  '    try:',
  '        step()',
  "        print(name, 'ok')",
  '    except OSError as e:',
  '        print(name, errno.errorcode[e.errno])',
].join('\n');

const WALKER = `export default async function main(ctx) {
  const { fs } = ctx;
  const text = (bytes) => new TextDecoder().decode(bytes).trim();
  const real = async (path) => {
    let done = [];
    let todo = path.split('/').filter(Boolean);
    while (todo.length > 0) {
      const part = todo.shift();
      if (part === '..') {
        done.pop();
        continue;
      }
      const at = '/' + [...done, part].join('/');
      if ((await fs.lstat(at)).isSymbolicLink) {
        const target = await fs.readlink(at);
        if (target.startsWith('/')) done = [];
        todo = [...target.split('/').filter(Boolean), ...todo];
      } else done.push(part);
    }
    return '/' + done.join('/');
  };
  const up = (path) => path.slice(0, path.lastIndexOf('/'));
  const out = [];
  for (const name of await fs.readdir('/sys/class/tty')) {
    const link = '/sys/class/tty/' + name + '/device';
    if (!(await fs.exists(link))) {
      out.push([name, 'none', text(await fs.readFile('/sys/class/tty/' + name + '/dev'))]);
      continue;
    }
    const device = await real(link);
    const subsystem = (await real(device + '/subsystem')).split('/').pop();
    const usb = up(subsystem === 'usb-serial' ? up(device) : device);
    const handle = await ctx.open(usb + '/idProduct');
    const product = text(await handle.read(0, 64));
    await handle.close();
    out.push([
      name,
      subsystem,
      text(await fs.readFile(usb + '/idVendor')),
      product,
      text(ctx.sync.fs.readFile(up(link) + '/uevent')).split('\\n').join(','),
      (await fs.stat(usb + '/idVendor')).mode.toString(8),
    ]);
  }
  out.push((await fs.readdir('/')).includes('sys'));
  for (const step of [
    () => fs.mkdir('/sys/x'),
    () => fs.writeFile('/sys/class/tty/ttyUSB0/dev', 'x'),
    () => ctx.open('/sys/class/tty/ttyUSB0/dev', { write: true }),
    () => fs.rm('/sys/class'),
  ]) {
    try {
      await step();
      out.push('ok');
    } catch (err) {
      out.push(err.code);
    }
  }
  await ctx.write(1, JSON.stringify(out) + '\\n');
}
`;

const QUIET = `export default async function main(ctx) {
  await ctx.fs.stat('/tmp');
  await ctx.fs.readdir('/');
  await ctx.fs.readFile('/etc/passwd');
  await ctx.write(1, 'quiet\\n');
}
`;

async function installDir(kernel, dir, at) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${at}/${relative(dir, file)}`, await readFile(file));
  }
}

async function jsCommand(kernel, name, source) {
  await kernel.writeFile(
    `/node_modules/${name}/package.json`,
    JSON.stringify({ name, slicc: { commands: { [name]: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile(`/node_modules/${name}/main.mjs`, source);
}

async function booted(t, packages = ['wasm-bash', 'wasm-coreutils'], options = {}) {
  const kernel = await createNodeKernel({
    ...options,
    users: 'enforce',
    devices: {
      open() {
        throw new Error('no port in this test');
      },
    },
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
  await jsCommand(kernel, 'syswalk', WALKER);
  await jsCommand(kernel, 'sysquiet', QUIET);
  await kernel.writeFile('/tmp/ports.py', PORTS);
  await kernel.writeFile('/tmp/writes.py', WRITES);
  await kernel.groups.add('dialout', { gid: 20 });
  const bash = (script, o = {}) => kernel.run(['bash', '-c', script], { cwd: '/tmp', ...o });
  return { kernel, bash };
}

test(
  'bash and coreutils see /sys/class/tty: a link per node, dev and uevent, and the USB ids of a node added with sys (Emscripten)',
  TIMEOUT,
  async (t) => {
    const { kernel, bash } = await booted(t);
    await kernel.devices.add(FTDI);
    await kernel.devices.add(PICO);
    await kernel.devices.add(BARE);
    const r = await bash(
      [
        'ls /sys/class/tty | tr "\\n" " "; echo',
        'readlink /sys/class/tty/ttyUSB0 /sys/class/tty/ttyACM0 /sys/class/tty/ttyUSB3',
        'cat /sys/class/tty/ttyUSB0/dev /sys/class/tty/ttyACM0/uevent',
        'd=$(readlink -f /sys/class/tty/ttyUSB0/device); echo "$d $(readlink -f "$d/subsystem")"',
        'cat "${d%/*/*}/idVendor" "${d%/*/*}/idProduct" "${d%/*/*}/manufacturer" "${d%/*/*}/product" "${d%/*/*}/serial"',
        'a=$(readlink -f /sys/class/tty/ttyACM0/device); echo "$a $(readlink -f "$a/subsystem")"',
        'cat /sys/class/tty/ttyACM0/device/../idVendor /sys/class/tty/ttyACM0/device/../idProduct "$a/bInterfaceNumber"',
        'ls /sys/class/tty/ttyUSB3/ | tr "\\n" " "; echo',
        'stat -c "%a %U %G %F" /sys /sys/class/tty/ttyUSB0/dev "${d%/*/*}/idVendor"',
        'stat -L -c "%s %F" /sys/class/tty/ttyUSB0/dev',
        'for n in $(ls /); do [ "$n" = sys ] && echo "$n"; done',
      ].join('\n')
    );
    assert.equal(r.stderr, '');
    assert.deepEqual(r.stdout.split('\n'), [
      'ttyACM0 ttyUSB0 ttyUSB3 ',
      '../../devices/platform/slicc_hcd.0/usb1/1-1/1-1:1.0/ttyUSB0/tty/ttyUSB0',
      '../../devices/platform/slicc_hcd.0/usb2/2-1/2-1:1.0/tty/ttyACM0',
      '../../devices/virtual/tty/ttyUSB3',
      '188:0',
      'MAJOR=166',
      'MINOR=0',
      'DEVNAME=ttyACM0',
      '/sys/devices/platform/slicc_hcd.0/usb1/1-1/1-1:1.0/ttyUSB0 /sys/bus/usb-serial',
      '0403',
      '6001',
      'FTDI',
      'FT232R USB UART',
      'A50285BI',
      '/sys/devices/platform/slicc_hcd.0/usb2/2-1/2-1:1.0 /sys/bus/usb',
      '2e8a',
      '0005',
      '00',
      'dev subsystem uevent ',
      '755 root root directory',
      '444 root root regular file',
      '444 root root regular file',
      '6 regular file',
      'sys',
      '',
    ]);
  }
);

test(
  "the kernel's own Emscripten imports, the Durable Object's async ones included, see the same tree",
  TIMEOUT,
  async (t) => {
    const { kernel, bash } = await booted(t, undefined, {
      emscripten: 'kernel',
      blocking: 'async',
    });
    await kernel.devices.add(FTDI);
    await kernel.devices.add(BARE);
    const r = await bash(
      [
        'ls /sys/class/tty | tr "\\n" " "',
        'd=$(readlink -f /sys/class/tty/ttyUSB0/device)',
        'cat "${d%/*/*}/idVendor" /sys/class/tty/ttyUSB0/device/../../product /sys/class/tty/ttyUSB3/dev',
        'mkdir /sys/x',
      ].join('; ')
    );
    assert.equal(r.stdout, 'ttyUSB0 ttyUSB3 0403\nFT232R USB UART\n188:3\n');
    assert.match(r.stderr, /cannot create directory ‘\/sys\/x’: Read-only file system/);
  }
);

test(
  "pyserial's list_ports walk finds each port's subsystem, ids and strings from a WASIX python, and a WASI program lists and stats the tree",
  TIMEOUT,
  async (t) => {
    const { kernel, bash } = await booted(t, ['wasm-bash', 'wasm-coreutils', 'wasix-python']);
    await kernel.devices.add(FTDI);
    await kernel.devices.add(PICO);
    await kernel.devices.add(BARE);
    const py = await bash('python3 ports.py');
    assert.equal(py.stderr, '');
    assert.deepEqual(py.stdout.split('\n'), [
      'ttyACM0 usb 2-1 2E8A:0005 1 00 None None None',
      'ttyUSB0 usb-serial 1-1 0403:6001 1 00 FTDI FT232R USB UART A50285BI',
      'ttyUSB3 none True',
      'ttyACM0 ttyUSB0 ttyUSB3 True',
      '',
    ]);
    const wasi = await bash(
      'ttyprobe ls /sys/class/tty; ttyprobe link /sys/class/tty/ttyACM0/device; ttyprobe lstat /sys/class/tty/ttyUSB0; ttyprobe stat /sys/class/tty/ttyUSB0; ttyprobe stat /sys/class/tty/ttyUSB0/device/subsystem; ttyprobe access /sys/class/tty/ttyUSB0/device/../../idVendor'
    );
    assert.equal(wasi.stderr, '');
    assert.deepEqual(wasi.stdout.split('\n'), [
      'ttyACM0',
      'ttyUSB0',
      'ttyUSB3',
      'link ../../../2-1:1.0',
      'lstat mode=120777 uid=0 gid=0',
      'stat mode=40755 uid=0 gid=0',
      'stat mode=40755 uid=0 gid=0',
      'access 0',
      '',
    ]);
  }
);

test(
  'a JS program walks the same tree with ctx.fs, ctx.open and ctx.sync.fs, and gets EROFS for writes there',
  TIMEOUT,
  async (t) => {
    const { kernel } = await booted(t, []);
    await kernel.devices.add(FTDI);
    await kernel.devices.add(PICO);
    await kernel.devices.add(BARE);
    const r = await kernel.run(['syswalk'], { cwd: '/' });
    assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout), [
      ['ttyACM0', 'usb', '2e8a', '0005', 'MAJOR=166,MINOR=0,DEVNAME=ttyACM0', '100444'],
      ['ttyUSB0', 'usb-serial', '0403', '6001', 'MAJOR=188,MINOR=0,DEVNAME=ttyUSB0', '100444'],
      ['ttyUSB3', 'none', '188:3'],
      true,
      'EROFS',
      'EROFS',
      'EROFS',
      'EROFS',
    ]);
  }
);

test('removing a node removes its /sys entries in every runtime', TIMEOUT, async (t) => {
  const { kernel, bash } = await booted(t, ['wasm-bash', 'wasm-coreutils', 'wasix-python']);
  const usb = await kernel.devices.add(FTDI);
  const acm = await kernel.devices.add(PICO);
  await usb.remove();
  const left = await bash(
    'ls /sys/class/tty; ls /sys/devices/platform/slicc_hcd.0; cat /sys/class/tty/ttyUSB0/dev; python3 ports.py; ttyprobe ls /sys/class/tty'
  );
  assert.equal(
    left.stdout,
    'ttyACM0\nusb2\nttyACM0 usb 2-1 2E8A:0005 1 00 None None None\nttyACM0 True\nttyACM0\n'
  );
  assert.match(left.stderr, /cat: \/sys\/class\/tty\/ttyUSB0\/dev: No such file or directory/);
  await acm.remove();
  const none = await bash(
    'ls /sys/class/tty | wc -l; ls /sys/devices | wc -l; ttyprobe ls /sys/class/tty'
  );
  assert.deepEqual(none, { status: 0, stdout: '0\n0\n', stderr: '' });
  const js = await kernel.run(['syswalk'], { cwd: '/' });
  assert.deepEqual(JSON.parse(js.stdout).slice(0, 1), [true]);
});

test(
  '/sys is read-only to root in every runtime: writes, creates, removals, renames and mode changes fail with EROFS',
  TIMEOUT,
  async (t) => {
    const { kernel, bash } = await booted(t, ['wasm-bash', 'wasm-coreutils', 'wasix-python']);
    await kernel.devices.add(FTDI);
    const shell = await bash(
      [
        'echo x > /sys/class/tty/ttyUSB0/dev',
        'mkdir /sys/x',
        'rm /sys/class/tty/ttyUSB0',
        'chmod 600 /sys/class/tty/ttyUSB0/dev',
        'touch /sys/new',
        'ln -s /tmp /sys/l',
        'ls /sys | tr "\\n" " "',
      ].join('; ')
    );
    assert.equal(shell.stdout, 'bus class devices ');
    assert.equal(shell.stderr.match(/Read-only file system/g)?.length, 6, shell.stderr);
    const py = await bash('python3 writes.py');
    assert.equal(
      py.stdout,
      'open EROFS\nmkdir EROFS\nunlink EROFS\nrename EROFS\nsymlink EROFS\nchmod EROFS\n'
    );
  }
);

test(
  'kernel.devices.add takes sys ids as numbers or hex strings and refuses a bad sys with EINVAL',
  TIMEOUT,
  async (t) => {
    const { kernel, bash } = await booted(t);
    await kernel.devices.add({ path: 'ttyUSB1', sys: { idVendor: '0x10C4', idProduct: 'ea60' } });
    await kernel.devices.add({ path: 'ttyUSB2', sys: {} });
    const cases = [
      { sys: null },
      { sys: [] },
      { sys: 'x' },
      { sys: { idVendor: 0x10000 } },
      { sys: { idVendor: -1 } },
      { sys: { idVendor: 1.5 } },
      { sys: { idProduct: '12345' } },
      { sys: { idProduct: 'zz' } },
      { sys: { manufacturer: 7 } },
      { sys: { product: 'a\nb' } },
      { sys: { serial: 'x'.repeat(256) } },
    ];
    for (const [i, spec] of cases.entries()) {
      await assert.rejects(
        kernel.devices.add({ path: `ttyACM${i}`, ...spec }),
        { code: 'EINVAL' },
        JSON.stringify(spec)
      );
    }
    const r = await bash(
      'cat /sys/devices/platform/slicc_hcd.0/usb1/1-2/idVendor /sys/devices/platform/slicc_hcd.0/usb1/1-2/idProduct /sys/devices/platform/slicc_hcd.0/usb1/1-3/idVendor /sys/devices/platform/slicc_hcd.0/usb1/1-3/uevent; ls /sys/devices/platform/slicc_hcd.0/usb1/1-3 | tr "\\n" " "; ls /sys/class/tty | tr "\\n" " "'
    );
    assert.equal(r.stderr, '');
    assert.equal(
      r.stdout,
      '10c4\nea60\n0000\nDEVTYPE=usb_device\nPRODUCT=0/0/0\n1-3:1.0 bNumInterfaces idProduct idVendor subsystem uevent ttyUSB1 ttyUSB2 '
    );
  }
);

test(
  'programs that never touch /sys ask the kernel for no device listing, in Emscripten, WASI, WASIX and JS programs',
  TIMEOUT,
  async (t) => {
    const { kernel, bash } = await booted(t, ['wasm-bash', 'wasm-coreutils', 'wasix-python']);
    await kernel.devices.add(FTDI);
    const ops = new Map();
    t.after(() => setTestSyscallHook(undefined));
    setTestSyscallHook(({ op }) => ops.set(op, (ops.get(op) ?? 0) + 1));
    const r = await bash(
      "ls -l / >/tmp/out; cat /etc/passwd >>/tmp/out; stat /tmp >>/tmp/out; ttyprobe ls /; ttyprobe stat /tmp; python3 -c \"import os; print('sys' in os.listdir('/'))\"; sysquiet"
    );
    setTestSyscallHook(undefined);
    assert.equal(r.stderr, '');
    assert.match(r.stdout, /\nsys\nstat mode=41777 uid=0 gid=0\nTrue\nquiet\n$/);
    assert.ok(ops.size > 0);
    assert.equal(ops.get('fd-dev-nodes') ?? 0, 0, JSON.stringify([...ops]));
    setTestSyscallHook(({ op }) => ops.set(op, (ops.get(op) ?? 0) + 1));
    await bash('cat /sys/class/tty/ttyUSB0/dev >/dev/null');
    setTestSyscallHook(undefined);
    assert.ok((ops.get('fd-dev-nodes') ?? 0) > 0);
  }
);
