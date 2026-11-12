import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, nodeTransport } from '../../../dist/node.js';

const modules = new URL('../../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

async function booted(t, mode, packages, options = {}) {
  const kernel = await createNodeKernel({ emscripten: mode, ...options });
  t.after(() => kernel.terminate());
  for (const name of packages) await install(kernel, name);
  return kernel;
}

async function pair(t, packages, options = {}) {
  const [glue, own] = await Promise.all([
    booted(t, 'glue', packages, options),
    booted(t, 'kernel', packages, options),
  ]);
  return { glue, own };
}

const shown = (r) => ({ status: r.status, stdout: r.stdout, stderr: r.stderr });

let serial = 0;

async function same(kernels, script, check) {
  const dir = `/tmp/case${++serial}`;
  const argv = ['bash', '-c', `mkdir -p ${dir} && cd ${dir} && { ${script}\n}`];
  const glue = shown(await kernels.glue.run(argv, { cwd: '/root' }));
  const own = shown(await kernels.own.run(argv, { cwd: '/root' }));
  assert.deepEqual(own, glue, script);
  check?.(own);
}

const BASE = ['wasm-bash', 'wasm-coreutils'];

test('tier 1: bash builtins and coreutils behave the same without the glue', async (t) => {
  const kernels = await pair(t, BASE);
  const cases = [
    "echo hello; printf '%s-%d\\n' a 5; type echo; command -v ls; help true | head -1",
    'x=1; y=$((x+41)); echo $y; unset x; echo ${x:-unset}; arr=(a b c); echo ${#arr[@]} ${arr[1]}',
    'declare -A m; m[k]=v; echo ${m[k]}; s="a b c"; set -- $s; echo $# $2; shift; echo $1',
    'f() { local v=$1; echo "f:$v"; return 3; }; f arg; echo $?; g() { f "$@"; }; g two',
    'echo $((7*6)) $((2**10)) $((17%5)) $((-7/2)); let z=5+5; echo $z; (( z > 3 )) && echo big',
    'echo out > r1; echo err 1>&2; cat r1; echo app >> r1; cat r1; cat < r1 | wc -l',
    'exec 3>fd3; echo three >&3; exec 3>&-; cat fd3; exec 4<fd3; read -u 4 line; echo "got $line"',
    'echo both > both 2>&1; ls nope 2>> both; cat both; echo x >/dev/null; echo y 2>/dev/null >&2',
    "cat <<END\nline1 $HOME\n  line2\nEND\ncat <<-END\n\tstripped\nEND\ncat <<'END'\nraw $HOME\nEND",
    'cat <<< "here string"; read a b <<< "x y"; echo $b$a; printf "1\\n2\\n" | while read l; do echo "n=$l"; done',
    'true; echo $?; false; echo $?; (exit 7); echo $?; ! true; echo $?; set -e; false || echo rescued',
    'if [ -d /tmp ]; then echo dir; fi; [ -e /nope ] || echo none; test -x /usr/bin/bash; echo $?; [[ abc == a* ]] && echo glob',
    'for i in 1 2 3; do echo $i; done; i=0; while [ $i -lt 3 ]; do i=$((i+1)); done; echo $i; case x in x) echo cx;; esac',
    'touch g1.txt g2.txt; echo g*.txt; shopt -s nullglob; echo none*; cd ..; cd -; pushd / >/dev/null; pwd; popd >/dev/null',
    'mkdir -p a/b/c && touch a/f && ls -R a && ls -la a | tail -n +2 | cut -c1-10',
    'echo x > f; ls -la | tail -n +2 | cut -c1-24; ls -l f; ls -s f; ls -i f >/dev/null && echo inode',
    'echo abc > c1; cat c1 c1; wc c1; wc -c < c1; wc -l -w c1',
    "printf 'a\\nb\\nc\\nd\\n' > h; head -2 h; tail -1 h; sort -r h; printf '3\\n1\\n2\\n' | sort -n; sort -u h | head -n1",
    'mkdir -p rr/x/y; touch rr/x/y/z; rm -r rr; ls rr; echo $?; rm nope; echo $?; rm -f nope; echo $?',
    'echo data > cp1; cp cp1 cp2; cat cp2; mv cp2 cp3; ls cp2 cp3; cat cp3; cp -r /tmp/case1 tree 2>&1; mkdir d; cp cp1 d/; ls d',
    'echo L > l1; ln l1 l2; echo $?; ln -s l1 l3; ln -s /nowhere dangling; cat l3; readlink l3 dangling; ls -l l3 | cut -c1-10',
    "touch st; chmod 640 st; stat -c '%a %A %s %F %U %G %h' st; chmod u+x st; stat -c %a st; chmod -R go-rwx . && stat -c %a st",
    "touch -d '2020-01-02 03:04:05' tt; stat -c '%y %Y' tt; ls -l --time-style=+%Y-%m tt | cut -d' ' -f6-; touch -r tt t2; stat -c %Y t2",
    "stat c1 2>&1 | head -1; mkdir sd; stat -c '%F %a' sd /dev/null; stat -L -c %F /dev/stdin",
    "date -d @0 -u; date -u -d '2021-05-06 07:08:09' +%s; date -u -d @86400 '+%A %j'; date +%Y > /dev/null && echo ok",
    'id; id -u; id -gn; whoami; groups',
    'uname; uname -a; uname -m; uname -s -r; hostname',
    'umask; umask 027; touch um; mkdir umd; stat -c "%a" um umd; umask 022',
    'echo -n abc | wc -c; echo $(( $(echo 5) + 1 )); seq 3; yes | head -2; basename /a/b.c .c; dirname /a/b/c',
    'ls nonexistent; echo $?; cat /nonexist; mkdir /tmp; echo $?; rm /tmp; rmdir /etc',
    'env | sort | cut -d= -f1 | head -5; echo $PWD; echo $HOME; echo $SHELL',
    'exit 3',
  ];
  for (const script of cases) await t.test(script, () => same(kernels, script));
});

const TIER2 = [...BASE, 'wasm-sed', 'wasm-tar', 'wasm-sqlite3', 'wasm-gmake', 'wasm-procps'];

test('tier 2: pipelines, subshells, jobs, signals and the other packages behave the same', async (t) => {
  const kernels = await pair(t, TIER2);
  const cases = [
    'printf "b\\na\\nc\\n" | sort | head -2 | tr a-z A-Z; echo x | cat | cat | wc -c; set -o pipefail; false | true; echo $?',
    'echo $(echo inner $(echo deeper)); (cd /tmp; pwd); pwd; x=$( (exit 4) ); echo $?; { echo g1; echo g2; } | wc -l',
    'diff <(echo a) <(echo a) && echo same; cat < <(echo procsub); echo $(cat <(echo inner))',
    'yes | head -1; echo ${PIPESTATUS[@]}; seq 100000 | head -1; echo ${PIPESTATUS[@]}; (trap "" PIPE; yes | head -1)',
    'sleep 0.2 & pid=$!; echo started; wait $pid; echo "waited $?"; (exit 5) & wait $!; echo $?',
    'sleep 0.1 & sleep 0.2 & jobs | wc -l; wait; echo all; sleep 3 & kill %1; wait; echo k=$?',
    'for i in 1 2 3; do (echo $i > o$i) & done; wait; cat o1 o2 o3',
    'sleep 5 & p=$!; kill $p; wait $p; echo "status $?"; sleep 3 & p=$!; kill -STOP $p; kill -CONT $p; kill -9 $p; wait $p; echo $?',
    'trap "echo got USR1" USR1; kill -USR1 $$; echo after; trap "echo bye" EXIT; echo end',
    'trap "echo int" INT; kill -INT $$; echo cont; trap "echo term" TERM; kill $$; echo alive',
    'trap "echo err" ERR; false; trap - ERR; f() { trap "echo ret" RETURN; }; f',
    '(trap "echo child-usr1; exit 9" USR1; kill -USR1 $BASHPID; echo no); echo st=$?; (kill -9 $BASHPID); echo $?',
    'trap "echo caught" USR1; (sleep 0.2; kill -USR1 $$) & read -t 2 x < <(sleep 1); echo rc=$?; wait',
    'read -t 0.3 x < <(sleep 2); echo "rc=$?"; timeout 0.3 sleep 5; echo rc=$?',
    'trap "echo alrm" ALRM; (sleep 0.2; kill -ALRM $$) & sleep 0.5; echo after',
    'coproc cat; echo hi >&${COPROC[1]}; exec {COPROC[1]}>&-; read -r l <&${COPROC[0]}; echo $l',
    'bash -c "exec echo replaced"; echo after; exec 9>&1; echo nine >&9; bash -c "exit 3"; echo $?',
    'mkfifo ff; (echo via-fifo > ff &); cat ff; ls -l ff | cut -c1-10; rm ff',
    'echo a | sed s/a/b/; printf "x\\ny\\n" | sed -n 2p; echo hello > s; sed -i s/hello/bye/ s; cat s; seq 10000 | sed -n "\\$p"',
    'mkdir -p tr/d; echo 1 > tr/a; echo 2 > tr/d/b; tar cf x.tar tr; tar tf x.tar | sort; mkdir ex; cd ex; tar xf ../x.tar; cat tr/a tr/d/b; tar czf ../y.tgz tr; echo $?',
    'sqlite3 db "create table t(a,b); insert into t values(1,2),(3,4); select * from t; select sum(a) from t;"; sqlite3 db "select count(*) from t"; sqlite3 db .dump',
    'printf "all: out\\nout: in\\n\\tcat in > out\\n\\techo built\\nclean:\\n\\trm -f out\\n" > Makefile; echo data > in; make; make; cat out; make clean',
    'printf "%%.o: %%.c\\n\\tcp \\$< \\$@\\nall: a.o b.o\\n\\techo linked\\n" > Makefile; touch a.c b.c; make -j2 2>&1 | sort; make',
    'ps; ps -o comm | sort; ps -e -o comm= | sort | head -3',
  ];
  for (const script of cases) await t.test(script, () => same(kernels, script));
});

async function transcript(kernel, steps) {
  let out = '';
  const term = await kernel.openTerminal(['bash', '-i'], {
    cwd: '/root',
    env: { PS1: '$ ', TERM: 'dumb' },
    onData: () => {},
  });
  term.onData = (bytes) => {
    out += new TextDecoder().decode(bytes);
  };
  const until = async (seen, ms = 10000) => {
    const end = Date.now() + ms;
    while (!seen() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  };
  await until(() => out.includes('$ '));
  for (const step of steps) {
    const mark = out.length;
    term.write(step.write);
    await until(() => out.slice(mark).includes(step.until ?? '$ '));
    await new Promise((r) => setTimeout(r, step.settle ?? 100));
  }
  term.write('exit\n');
  return { status: await term.exited, out };
}

test('tier 3: an interactive bash on a terminal behaves the same', async (t) => {
  const kernels = await pair(t, BASE);
  const steps = [
    { write: 'echo hi\n' },
    { write: 'tty; [ -t 0 ] && echo isatty; stty -a | head -1\n' },
    { write: 'read -p "name? " n\n', until: 'name? ' },
    { write: 'bob\n' },
    { write: 'echo $n\n' },
    { write: 'sleep 10\n', until: '', settle: 300 },
    { write: '\u0003' },
    { write: 'sleep 10\n', until: '', settle: 300 },
    { write: '\u001a', until: 'Stopped' },
    { write: 'jobs\n' },
    { write: 'fg\n', until: 'sleep', settle: 300 },
    { write: '\u0003' },
    { write: 'echo $?\n' },
    { write: 'cat\n', until: '', settle: 200 },
    { write: 'line1\n', until: 'line1\r\nline1' },
    { write: '\u0004' },
    { write: 'stty -echo; echo hidden; stty echo\n' },
    { write: 'kill -INT $$; echo still\n' },
  ];
  const glue = await transcript(kernels.glue, steps);
  const own = await transcript(kernels.own, steps);
  assert.deepEqual(own, glue);
  assert.match(own.out, /\^Z\r\n\[1\]\+ +Stopped +sleep 10/);
});

test('tier 3: git init, add, commit and log behave the same', async (t) => {
  const kernels = await pair(t, [...BASE, 'wasm-git']);
  const when = 'GIT_AUTHOR_DATE=2020-01-01T00:00:00Z GIT_COMMITTER_DATE=2020-01-01T00:00:00Z';
  const cases = [
    `git init -q -b main . && git config user.email a@b.c && git config user.name A && echo hi > f && git add f && ${when} git commit -q -m first && git log --format="%H %an %s" && git status --short && echo x >> f && git diff --stat && git ls-files`,
    `git init -q -b main . && git config user.email a@b.c && git config user.name A && echo 1 > a && git add a && ${when} git commit -q -m one && git checkout -q -b side && echo 2 > b && git add b && ${when} git commit -q -m two && git log --oneline --all | cat && git branch && git checkout -q main && ls && git log | cat`,
  ];
  for (const script of cases) await t.test(script, () => same(kernels, script));
});

test('tier 3: curl over a host server behaves the same', async (t) => {
  const server = createServer((req, res) => {
    res.setHeader('x-test', 'yes');
    res.end(`host says ${req.method} ${req.url}\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const transport = nodeTransport({ hostLoopback: true });
  const kernels = await pair(t, [...BASE, 'wasm-curl', 'wasm-tls-engine'], {
    network: { transport },
  });
  const url = `http://host.slicc.internal:${port}`;
  const cases = [
    `curl -s ${url}/a?b=1; curl -s -i ${url}/x | head -1; curl -s -o o -w "%{http_code}\\n" -X POST -d data ${url}/p; cat o`,
    'curl -s file:///etc/hostname; curl -s http://127.0.0.1:1/; echo rc=$?',
  ];
  for (const script of cases) await t.test(script, () => same(kernels, script));
});

test('kernel mode never evaluates the package glue', async (t) => {
  const kernel = await booted(t, 'kernel', BASE);
  for (const name of ['wasm-bash/bin/bash', 'wasm-coreutils/bin/coreutils']) {
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}`,
      'throw new Error("glue evaluated");\n'
    );
  }
  const r = await kernel.run(['bash', '-c', 'echo $(ls -d /tmp) ok'], { cwd: '/' });
  assert.deepEqual(shown(r), { status: 0, stdout: '/tmp ok\n', stderr: '' });
});

function importing(names) {
  const name = (text) => [text.length, ...new TextEncoder().encode(text)];
  const section = (id, body) => [id, body.length, ...body];
  const imports = [names.length];
  for (const field of names) imports.push(...name('env'), ...name(field), 0, 0);
  return Uint8Array.from([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...section(1, [1, 0x60, 0, 0]),
    ...section(2, imports),
    ...section(5, [1, 0, 1]),
    ...section(7, [1, ...name('memory'), 2, 0]),
  ]);
}

test('a program importing what the kernel does not provide fails with 126 and names the imports', async (t) => {
  const kernel = await booted(t, 'kernel', ['wasm-bash']);
  const pkg = {
    name: 'fake-em',
    slicc: { abi: 'emscripten', commands: { fake: { glue: 'bin/fake', wasm: 'bin/fake.wasm' } } },
  };
  await kernel.writeFile('/node_modules/fake-em/package.json', JSON.stringify(pkg));
  await kernel.writeFile('/node_modules/fake-em/bin/fake', 'var Module = {};\n');
  await kernel.writeFile('/node_modules/fake-em/bin/fake.wasm', importing(['nope', 'also_missed']));
  const r = await kernel.run(['fake'], { cwd: '/' });
  assert.equal(r.status, 126);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /env\.nope, env\.also_missed/);
  assert.doesNotMatch(r.stderr, /LinkError|at /);
});
