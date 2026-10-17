import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const PROMPT = '[$#] ';
const chrome = await launch();
after(() => chrome.close());

async function terminal(chrome, t, argv, options) {
  const { page } = await booted(chrome, t);
  await page.evaluate((a, o) => window.terminal(a, o), argv, options);
  const screen = () => page.evaluate(() => window.screen.screen);
  const until = async (text, from = 0, ms = undefined) => {
    const shows = (s, f) =>
      s === '[$#] '
        ? /[$#] /.test(window.screen.screen.slice(f))
        : window.screen.screen.slice(f).includes(s);
    try {
      await (ms === undefined ? page.until(shows, text, from) : page.within(ms, shows, text, from));
    } catch (err) {
      const tail = JSON.stringify((await screen()).slice(-1500));
      throw new Error(
        `${err.message}\nwaiting for ${JSON.stringify(text)}; the screen ends with ${tail}`
      );
    }
  };
  const type = async (input, expected) => {
    const from = (await screen()).length;
    await page.evaluate((i) => window.term.write(i), input);
    if (expected) await until(expected, from);
  };
  return { page, screen, until, type };
}

test('an interactive bash runs commands and reports its size, also after a resize', async (t) => {
  const { page, screen, until, type } = await terminal(chrome, t, ['bash', '-i'], {
    cwd: '/home',
    cols: 80,
    rows: 24,
  });
  await until('bash-5.3# ');
  await type('echo "hi from $PWD"\r', 'hi from /home');
  await type('stty size\r', '24 80');
  await until(PROMPT, (await screen()).lastIndexOf('24 80'));
  await page.evaluate(() => window.term.resize(100, 30));
  const settled = (await screen()).length;
  await type('true\r');
  await until(PROMPT, settled);
  await type('stty size; echo "cols $COLUMNS"\r', 'cols 100');
  assert.match(await page.evaluate(() => window.screen.screen), /30 100\r\ncols 100/);
  assert.deepEqual(page.errors, []);
});

test('^C interrupts the foreground job, ^Z stops it, and exit ends the session with its status', async (t) => {
  const { page, screen, until, type } = await terminal(chrome, t, ['bash', '-i'], { cwd: '/home' });
  const prompted = async (input, expected) => {
    await type(input, expected);
    const shown = await screen();
    await until(PROMPT, shown.lastIndexOf(expected) + expected.length);
  };
  await until(PROMPT);
  const job = 'sh -c "echo \\$((6*7)); exec sleep 30"\r';
  await type(job, '42\r\n');
  await prompted('\u0003', '^C');
  await prompted('echo "rc $?"\r', 'rc 130');
  await type(job, '42\r\n');
  await prompted('\u001a', 'Stopped');
  const stopped = (await screen()).length;
  await prompted('kill %1; wait\r', 'Terminated');
  await prompted('echo listed\r', 'listed');
  assert.match((await screen()).slice(stopped), /Terminated/);
  await type(job, '42\r\n');
  await page.evaluate(() => window.term.signal('SIGINT'));
  await until(PROMPT, (await screen()).lastIndexOf('42\r\n') + 4);
  await prompted('echo "signalled $?"\r', 'signalled 130');
  await type(job, '42\r\n');
  const before = (await screen()).length;
  await page.evaluate(() => window.term.signal('SIGTSTP'));
  await until('Stopped', before);
  await until(PROMPT, (await screen()).lastIndexOf('Stopped'));
  await prompted('kill -9 %1; wait\r', 'Killed');
  await prompted('echo listed\r', 'listed');
  assert.match((await screen()).slice(before), /Killed/);
  await type('exit 3\r');
  await page.until(() => window.screen.status === 3);
});

test('a WASIX program makes its terminal really raw through slicc_tty and sets it back', async (t) => {
  const { page, screen, until, type } = await terminal(chrome, t, ['bash', '-i'], { cwd: '/home' });
  await until(PROMPT);
  await type('ttytest\r', 'RAW\n');
  assert.doesNotMatch(await screen(), /RAW\r\n/);
  await type('\u0003', '=000000010300011c0018500008');
  await type('stty -a\r', '\r\nisig icanon');
  await type('ttytest < /dev/null 2>/dev/null | cat\r', '=3bffffffffffffff3b00003b08');
  assert.deepEqual(page.errors, []);
});

test('closing a terminal hangs up its shell', async (t) => {
  const { page, until } = await terminal(chrome, t, ['bash', '-i'], { cwd: '/home' });
  await until(PROMPT);
  await page.evaluate(() => window.term.close());
  await page.until(() => window.screen.status === 129);
});

test('every terminal of a kernel gives its programs a working stdout, also after the first closes', async (t) => {
  const { page, screen, until, type } = await terminal(chrome, t, ['bash', '-i'], { cwd: '/home' });
  await until(PROMPT);
  await type('echo one > a.txt; cat a.txt; tty\r', 'one\r\n/dev/tty1');
  for (const name of ['/dev/tty2', '/dev/tty3']) {
    if (name === '/dev/tty3') await page.evaluate(() => window.term.close());
    await page.evaluate(() => window.terminal(['bash', '-i'], { cwd: '/home' }));
    await until(PROMPT);
    await type('cat a.txt; tty; echo "rc $?"\r', 'rc 0');
    const shown = await page.evaluate(() => window.screen.screen);
    assert.match(shown, new RegExp(`one\\r\\n${name}\\r\\nrc 0`));
    assert.doesNotMatch(shown, /No such file or directory/);
  }
  assert.deepEqual(page.errors, []);
});
