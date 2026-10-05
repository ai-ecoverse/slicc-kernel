import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('two wasm processes talk over loopback AF_INET', async (t) => {
  const { page, bash } = await booted(chrome, t);

  const script = [
    'socktest server 7070 2 > /tmp/inet.log &',
    'until out=$(socktest client 127.0.0.1 7070 hello); do sleep 0.05; done',
    'echo "$out"',
    'socktest client 127.0.0.1 7070 again',
    'wait',
    'cat /tmp/inet.log',
  ].join('\n');
  assert.deepEqual(
    await bash(script),
    ok(
      'connect: in progress\ndontwait: EAGAIN\npeek H, reply HELLO\nconnect: in progress\ndontwait: EAGAIN\npeek A, reply AGAIN\nlistening 7070\naccepted\naccepted\n'
    )
  );
  assert.deepEqual(page.errors, []);
});

test('two wasm processes talk over an AF_UNIX socket in the filesystem', async (t) => {
  const { page, bash } = await booted(chrome, t);

  const script = [
    'socktest unixserver /tmp/echo.sock 1 > /tmp/unix.log &',
    'until out=$(socktest unixclient /tmp/echo.sock "over unix"); do sleep 0.05; done',
    'echo "$out"',
    'wait',
    'cat /tmp/unix.log',
  ].join('\n');
  assert.deepEqual(await bash(script), ok('reply OVER UNIX\nlistening /tmp/echo.sock\naccepted\n'));
  assert.deepEqual(page.errors, []);
});

test('a refused connection, an unreachable address and an unknown host fail as POSIX says', async (t) => {
  const { bash } = await booted(chrome, t);

  const { status, stdout } = await bash('socktest errors 7071');
  assert.equal(status, 0);
  assert.match(stdout, /^loopback: Connection refused$/m);
  assert.match(stdout, /^remote: /m);
});
