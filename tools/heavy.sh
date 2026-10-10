#!/bin/sh
if [ -z "${SLICC_HEAVY_LOCKED:-}" ] && command -v lockf > /dev/null 2>&1; then
  SLICC_HEAVY_LOCKED=1 exec lockf -k "${SLICC_HEAVY_LOCK:-/tmp/slicc-heavy.lock}" "$0" "$@"
fi
tree_kb=${SLICC_HEAVY_TREE_KB:-3000000}
proc_kb=${SLICC_HEAVY_PROC_KB:-2000000}
measure() {
  ps -axo pid=,ppid=,pgid=,rss= | awk -v root="$child" '
    { parent[$1] = $2; group[$1] = $3; rss[$1] = $4 }
    END {
      sum = 0; max = 0; pids = ""
      for (p in parent) {
        q = p; hops = 0
        while (q != root && (q in parent) && hops++ < 64) q = parent[q]
        if (q != root && group[p] != root) continue
        sum += rss[p]; if (rss[p] > max) max = rss[p]; pids = pids " " p
      }
      print sum, max, pids
    }'
}
stop() {
  trap - HUP INT TERM
  set -- $(measure)
  shift 2
  kill -9 "$@" 2> /dev/null
  wait "$child" 2> /dev/null
}
set -m
"$@" &
child=$!
trap 'stop; exit 129' HUP
trap 'stop; exit 130' INT
trap 'stop; exit 143' TERM
peak=0
while kill -0 "$child" 2> /dev/null; do
  set -- $(measure)
  sum=${1:-0}
  max=${2:-0}
  [ "$sum" -gt "$peak" ] && peak=$sum
  if [ "$sum" -gt "$tree_kb" ] || [ "$max" -gt "$proc_kb" ]; then
    printf 'heavy.sh: stopped at %s KB for the process tree, %s KB for one process (caps %s and %s KB)\n' "$sum" "$max" "$tree_kb" "$proc_kb" >&2
    stop
    exit 137
  fi
  sleep 0.25
done
wait "$child"
status=$?
stop
[ -n "${SLICC_HEAVY_REPORT:-}" ] && printf 'heavy.sh: peak %s KB for the process tree\n' "$peak" >&2
exit "$status"
