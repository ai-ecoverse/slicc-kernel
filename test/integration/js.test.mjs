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
  assert.deepEqual(
    await bash('jstest devices < /dev/null; jstest devices < /dev/zero'),
    ok('0 true\n8 true\n')
  );
  assert.deepEqual(await bash('jstest full > /dev/full'), {
    status: 0,
    stdout: '',
    stderr: 'ENOSPC\n',
  });
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
  assert.deepEqual(
    await run(['jstest', 'closed', 'k.txt'], home),
    ok('EBADF,EBADF,EBADF,EBADF,EBADF,EBADF keep\n')
  );
  assert.deepEqual(
    await run(['jstest', 'badtrunc', 't.txt'], home),
    ok('EINVAL,EINVAL,EINVAL 3 abc\n')
  );
  assert.deepEqual(await run(['jstest', 'dangling', 'd.lnk'], home), ok('EEXIST false\n'));
  assert.deepEqual(await run(['jstest', 'selfloop', 'loop.lnk'], home), ok('EEXIST\n'));
  assert.deepEqual(await run(['jstest', 'alias', 'adir'], home), ok('one TWO TWO+\n'));
  assert.deepEqual(await run(['jstest', 'aliasrm', 'rmdir1'], home), ok('keep keep! true\n'));
  assert.deepEqual(await run(['jstest', 'ctxclose', 'q.txt'], home), ok('true EBADF keep\n'));
  assert.deepEqual(
    await run(['jstest', 'badpos', 'p.txt'], home),
    ok('EINVAL,EINVAL,EINVAL,EINVAL,EINVAL,EINVAL abc\n')
  );
  assert.deepEqual(
    await bash('jstest unawaited | head -c 1 >/dev/null; echo "${PIPESTATUS[0]}"'),
    ok('141\n')
  );
  const bg = (await bash('jstest pid & p=$!; wait; echo "$p $$"')).stdout.trim().split('\n');
  assert.equal(bg[0], bg[1]);
  const ex = (await bash(`bash -c 'echo "$$ $PPID"; exec jstest pid'; true`)).stdout
    .trim()
    .split('\n');
  assert.equal(ex[1], ex[0]);
  assert.deepEqual(
    await bash('jstest queued | wc -c; jstest queued | tail -c 4'),
    ok('3145732\nEND\n')
  );
  assert.deepEqual(
    await bash(
      `bash -c 'trap "" PIPE; jstest resetpipe | head -c 1 >/dev/null; echo "\${PIPESTATUS[0]}"'`
    ),
    ok('141\n')
  );
  assert.deepEqual(
    await bash(
      'jstest nap 3000 > n.out & p=$!; until [ -n "$(cat n.out 2>/dev/null)" ]; do sleep 0.05; done; kill -STOP $p; sleep 3.5; kill -CONT $p; wait $p; echo "st=$?"'
    ),
    { status: 0, stdout: 'st=3\n', stderr: 'held\n' }
  );
  assert.deepEqual(await bash('jstest badmax < /dev/null'), ok('EINVAL,EINVAL,EINVAL,EINVAL\n'));
  assert.deepEqual(await run(['jstest', 'strayw']), {
    status: 1,
    stdout: '',
    stderr: 'jstest: fd-info: EBADF\n',
  });
  assert.deepEqual(
    await bash(
      `bash -c 'trap "" PIPE; jstest yes | head -c 1 >/dev/null; echo "\${PIPESTATUS[0]}"'`
    ),
    { status: 0, stdout: '1\n', stderr: 'jstest: fd-write: EPIPE\n' }
  );
});

test('a JS program makes the same calls synchronously, and a caught signal restarts a blocked one', async (t) => {
  const { bash, run } = await booted(chrome, t);
  assert.deepEqual(
    await run(['jstest', 'syncfiles', 'sd'], { cwd: '/home' }),
    ok(
      '2097157 true 3 EBADF,ENOENT,EEXIST,EISDIR,EINVAL,ENOENT,ENOENT,EBADF big.bin,link,log,two two one true 4 false abcd\n'
    )
  );
  assert.deepEqual(
    await bash('yes abcdefgh | head -c 3000000 | jstest synccat | wc -c'),
    ok('3000000\n')
  );
  assert.deepEqual(
    await bash('jstest syncyes | head -c 4 >/dev/null; echo "${PIPESTATUS[0]}"'),
    ok('141\n')
  );
  assert.deepEqual(
    await bash('jstest syncyes ignore | head -c 4 >/dev/null; echo "${PIPESTATUS[0]}"'),
    { status: 0, stdout: '7\n', stderr: 'EPIPE\n' }
  );
  assert.deepEqual(await bash('jstest syncdev < /dev/zero 2>/dev/null'), ok('8 true\n'));
  assert.deepEqual(
    await bash(
      'cd /home; (sleep 2; echo data) | jstest synctrap > s.out & until [ -n "$(cat /home/s.out 2>/dev/null)" ]; do sleep 0.05; done; kill -USR1 $!; wait $!; echo "st=$?"; cat /home/s.out'
    ),
    ok('st=0\nready\ncaught 10 data\n')
  );
  assert.deepEqual(
    await bash(
      'cd /home; sleep 3 2>/dev/null | jstest syncexit > e.out & until [ -n "$(cat /home/e.out 2>/dev/null)" ]; do sleep 0.05; done; kill -INT $!; sleep 1; kill -0 $! 2>/dev/null && echo alive; wait $!; echo "st=$?"'
    ),
    ok('st=42\n')
  );
  assert.deepEqual(
    await bash(
      'cd /home; sleep 3 2>/dev/null | jstest syncthrow 2>t.err > t.out & until [ -n "$(cat /home/t.out 2>/dev/null)" ]; do sleep 0.05; done; kill -INT $!; sleep 1; kill -0 $! 2>/dev/null && echo alive; wait $!; echo "st=$?"; cat t.err'
    ),
    ok('st=1\njstest: handler boom\n')
  );
});

test('a file whose suffix a package maps (binfmt) runs with that command, unless #! says otherwise', async (t) => {
  const { bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash('cd /home && printf "x\\n" > s.jse && chmod +x s.jse && ./s.jse a "b c"'),
    ok('jsecho|./s.jse|a|b c\n')
  );
  assert.deepEqual(
    await bash(
      'cd /home && printf "#!/usr/bin/env jsecho one\\n" > sh.jse && chmod +x sh.jse && ./sh.jse two'
    ),
    ok('jsecho|one|./sh.jse|two\n')
  );
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

test('on a terminal: isatty, ^C to a handler or by default, ^Z and fg, ^Z then kill', async (t) => {
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
  await type('jstest readycount\r', 'ready\r\n');
  await type('\u001a', 'Stopped');
  await type('fg\r', 'jstest readycount');
  await type('abcdefghij\r');
  await type('\u0004', '11\r\n');
  await type('jstest wait\r', 'ready');
  await type('\u001a', 'Stopped');
  const stopped = (await screen()).length;
  await type('kill %1\r');
  await type('sleep 0.3; jobs; echo "listed $?"\r', 'listed 0');
  await until('Terminated', stopped);
  assert.deepEqual(page.errors, []);
});
