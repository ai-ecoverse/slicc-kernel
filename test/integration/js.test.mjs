import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a JS program runs as a process: argv, pipes with backpressure, files, exit statuses', async (t) => {
  const { page, bash, run } = await booted(chrome, t);
  assert.deepEqual(
    await run(['jstest', 'echo', 'a b'], { cwd: '/home' }),
    ok('jstest|echo|a b\n/home\n/node_modules/jstest\ntrue\n/x/y\n1\n')
  );
  assert.deepEqual(await bash('echo hello | jstest cat | jstest cat'), ok('hello\n'));
  assert.deepEqual(await bash('yes abcdefgh | head -c 8000000 | jstest count'), ok('8000000\n'));
  assert.deepEqual(
    await bash('jstest yes | head -c 4; echo " ${PIPESTATUS[0]}"'),
    ok('y\ny\n 141\n')
  );
  const size = 3 * 1024 * 1024 + 21;
  assert.deepEqual(
    await run(['jstest', 'files', 'big.bin'], { cwd: '/home' }),
    ok(`${size} true tail 10 10 true 0.1.2\n`)
  );
  assert.deepEqual(
    await run(['jstest', 'fsops', 'fsdir'], { cwd: '/home' }),
    ok('b,link,two.txt two.txt one true false ENOENT,EEXIST,EISDIR false\n')
  );
  assert.deepEqual(await run(['jstest', 'exit', '300']), { status: 44, stdout: '', stderr: '' });
  assert.deepEqual(await run(['jstest', 'throw', 'boom']), {
    status: 1,
    stdout: '',
    stderr: 'jstest: boom\n',
  });
  assert.deepEqual(await run(['jsbroken']), {
    status: 126,
    stdout: '',
    stderr: 'jsbroken: broken at load\n',
  });
  assert.deepEqual(await run(['jstest', 'stray']), {
    status: 1,
    stdout: '',
    stderr: 'jstest: late\n',
  });
  assert.deepEqual(page.errors, []);
});

test('open files and path operations agree, append appends, exclusive creation is atomic', async (t) => {
  const { bash, run } = await booted(chrome, t);
  const home = { cwd: '/home' };
  assert.deepEqual(
    await run(['jstest', 'coherent', 'c.txt'], home),
    ok('hello world! World! World!? false\n')
  );
  assert.deepEqual(await run(['jstest', 'append', 'a.txt'], home), ok('abcdef\n'));
  assert.deepEqual(await run(['jstest', 'exclusive', 'x.lock'], home), ok('1 EEXIST\n'));
  const locks = await bash('cd /home && for i in 1 2 3 4 5 6; do jstest lock z.lock & done; wait');
  assert.deepEqual(locks.stdout.split('\n').filter(Boolean).sort(), [
    'EEXIST',
    'EEXIST',
    'EEXIST',
    'EEXIST',
    'EEXIST',
    'got',
  ]);
  assert.deepEqual(await run(['jstest', 'nodir', 'no/such/dir/f'], home), ok('ENOENT\n'));
});

test('a JS program gets WebCodecs in its process worker, and no network or storage of its own', async (t) => {
  const { run } = await booted(chrome, t);
  const g = await run(['jstest', 'globals']);
  assert.match(
    g.stdout,
    /fetch=undefined XMLHttpRequest=undefined WebSocket=undefined Worker=undefined indexedDB=undefined caches=undefined postMessage=undefined importScripts=undefined storage=undefined locks=undefined/
  );
  assert.match(
    g.stdout,
    /VideoEncoder=function VideoDecoder=function AudioEncoder=function ImageDecoder=function OffscreenCanvas=function/
  );
  assert.deepEqual(
    await run(['jstest', 'encode']),
    ok('supported=true chunks=3 first=key bytes>0=true\n')
  );
});

test('on a terminal: isatty, ^C to a handler or by default, ^Z, then kill', async (t) => {
  const { page } = await booted(chrome, t);
  await page.evaluate((a, o) => window.terminal(a, o), ['bash', '-i'], { cwd: '/home' });
  const screen = () => page.evaluate(() => window.screen.screen);
  const until = async (text, from = 0) => {
    try {
      await page.within(20_000, (s, f) => window.screen.screen.slice(f).includes(s), text, from);
    } catch (err) {
      throw new Error(`waiting for ${JSON.stringify(text)} on:\n${(await screen()).slice(from)}`, {
        cause: err,
      });
    }
  };
  const type = async (input, expected) => {
    const from = (await screen()).length;
    await page.evaluate((i) => window.term.write(i), input);
    if (expected) await until(expected, from);
  };
  await until('$ ');
  await type('jstest fds\r', '0:tty:true:false:true 1:tty:true:false:true 2:tty:true:false:true');
  await type('jstest trap SIGINT 130\r', 'ready');
  await type('\u0003', 'caught 2');
  await type('echo "rc $?"\r', 'rc 130');
  await type('jstest wait\r', 'ready');
  await type('\u0003');
  await type('echo "rc $?"\r', 'rc 130');
  await type('jstest wait\r', 'ready');
  await type('\u001a', 'Stopped');
  await type('kill %1; wait %1; echo "killed $?"\r', 'killed 143');
  assert.deepEqual(page.errors, []);
});
