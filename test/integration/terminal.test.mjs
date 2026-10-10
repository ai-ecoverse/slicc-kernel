import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

async function terminal(chrome, t, argv, options) {
  const { page } = await booted(chrome, t);
  await page.evaluate((a, o) => window.terminal(a, o), argv, options);
  const screen = () => page.evaluate(() => window.screen.screen);
  const until = async (text, from = 0) => {
    await page.until((s, f) => window.screen.screen.slice(f).includes(s), text, from);
  };
  const type = async (input, expected) => {
    const from = (await screen()).length;
    await page.evaluate((i) => window.term.write(i), input);
    if (expected) await until(expected, from);
  };
  return { page, screen, until, type };
}

test('an interactive bash runs commands and reports its size, also after a resize', async (t) => {
  const { page, until, type } = await terminal(chrome, t, ['bash', '-i'], {
    cwd: '/home',
    cols: 80,
    rows: 24,
  });
  await until('$ ');
  await type('echo "hi from $PWD"\r', 'hi from /home');
  await type('stty size\r', '24 80');
  await page.evaluate(() => window.term.resize(100, 30));
  await type('stty size; echo "cols $COLUMNS"\r', 'cols 100');
  assert.match(await page.evaluate(() => window.screen.screen), /30 100\r\ncols 100/);
  assert.deepEqual(page.errors, []);
});

test('^C interrupts the foreground job, ^Z stops it, and exit ends the session with its status', async (t) => {
  if (process.env.SLICC_TIMING_TESTS !== '1') {
    return t.skip('timing-sensitive under load (#240); set SLICC_TIMING_TESTS=1');
  }
  const { page, screen, until, type } = await terminal(chrome, t, ['bash', '-i'], { cwd: '/home' });
  await until('$ ');
  await type('sh -c "echo \\$((6*7)); exec sleep 30"\r', '42\r\n');
  await type('\u0003', '^C');
  await type('echo "rc $?"\r', 'rc 130');
  await type('sh -c "echo \\$((6*7)); exec sleep 30"\r', '42\r\n');
  await type('\u001a', 'Stopped');
  const stopped = (await screen()).length;
  await type('kill %1; wait\r');
  await until('Terminated', stopped);
  await type('echo listed\r', 'listed');
  assert.match((await screen()).slice(stopped), /Terminated/);
  await type('sh -c "echo \\$((6*7)); exec sleep 30"\r', '42\r\n');
  await page.evaluate(() => window.term.signal('SIGINT'));
  await type('echo "signalled $?"\r', 'signalled 130');
  await type('sh -c "echo \\$((6*7)); exec sleep 30"\r', '42\r\n');
  const before = (await screen()).length;
  await page.evaluate(() => window.term.signal('SIGTSTP'));
  await until('Stopped', before);
  await type('kill -9 %1; wait\r');
  await until('Killed', before);
  await type('echo listed\r', 'listed');
  assert.match((await screen()).slice(before), /Killed/);
  await type('exit 3\r');
  await page.until(() => window.screen.status === 3);
});

test('closing a terminal hangs up its shell', async (t) => {
  const { page, until } = await terminal(chrome, t, ['bash', '-i'], { cwd: '/home' });
  await until('$ ');
  await page.evaluate(() => window.term.close());
  await page.until(() => window.screen.status === 129);
});

test('every terminal of a kernel gives its programs a working stdout, also after the first closes', async (t) => {
  const { page, until, type } = await terminal(chrome, t, ['bash', '-i'], { cwd: '/home' });
  await until('$ ');
  await type('echo one > a.txt; cat a.txt; tty\r', 'one\r\n/dev/tty1');
  for (const name of ['/dev/tty2', '/dev/tty3']) {
    if (name === '/dev/tty3') await page.evaluate(() => window.term.close());
    await page.evaluate(() => window.terminal(['bash', '-i'], { cwd: '/home' }));
    await until('$ ');
    await type('cat a.txt; tty; echo "rc $?"\r', 'rc 0');
    const shown = await page.evaluate(() => window.screen.screen);
    assert.match(shown, new RegExp(`one\\r\\n${name}\\r\\nrc 0`));
    assert.doesNotMatch(shown, /No such file or directory/);
  }
  assert.deepEqual(page.errors, []);
});
