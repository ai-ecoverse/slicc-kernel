import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../../dist/node.js';
import { installPackage, shown, skip } from './async-wasi-harness.mjs';

const BASE = ['wasm-bash', 'wasm-coreutils'];

async function booted(t, options) {
  const kernel = await createNodeKernel(options);
  t.after(() => kernel.terminate());
  for (const name of BASE) await installPackage(kernel, name);
  return kernel;
}

async function pair(t) {
  const [oracle, own] = await Promise.all([
    booted(t, { emscripten: 'glue' }),
    booted(t, { blocking: 'async', emscripten: 'kernel' }),
  ]);
  return { oracle, own };
}

let serial = 0;

async function same(kernels, script) {
  const dir = `/tmp/case${++serial}`;
  const argv = ['bash', '-c', `mkdir -p ${dir} && cd ${dir} && { ${script}\n}`];
  const oracle = shown(await kernels.oracle.run(argv, { cwd: '/root' }));
  const own = shown(await kernels.own.run(argv, { cwd: '/root' }));
  assert.deepEqual(own, oracle, script);
}

test('bash and coreutils on the async host with the kernel personality match the glue on the sync kernel', {
  skip,
}, async (t) => {
  const kernels = await pair(t);
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

test('the milestone pipeline runs on the async host', { skip }, async (t) => {
  const kernels = await pair(t);
  const script =
    'echo a | cat; x=$(uname); echo $x; ls / | head -3; for i in 1 2 3; do echo $i; done | wc -l';
  const r = shown(await kernels.own.run(['bash', '-c', script], { cwd: '/root' }));
  assert.deepEqual(r, shown(await kernels.oracle.run(['bash', '-c', script], { cwd: '/root' })));
  assert.deepEqual(r, { status: 0, stdout: 'a\nLinux\nbin\ndev\netc\n3\n', stderr: '' });
});

test('a background job, a subshell and wait on the async host', { skip }, async (t) => {
  const kernels = await pair(t);
  for (const script of [
    'echo data > f; cat f; (sleep 0.1; echo bg) & wait; echo done',
    'sleep 0.05 & p=$!; wait $p; echo "waited $?"; (exit 4) & wait $!; echo $?',
    'trap "echo trapped" USR1; kill -USR1 $$; echo after',
  ]) {
    await t.test(script, () => same(kernels, script));
  }
});
