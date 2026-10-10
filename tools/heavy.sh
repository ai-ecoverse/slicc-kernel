#!/bin/sh
if [ -z "${SLICC_HEAVY_LOCKED:-}" ] && command -v lockf > /dev/null 2>&1; then
  SLICC_HEAVY_LOCKED=1 exec lockf -k "${SLICC_HEAVY_LOCK:-/tmp/slicc-heavy.lock}" "$0" "$@"
fi
tree_kb=${SLICC_HEAVY_TREE_KB:-3000000}
proc_kb=${SLICC_HEAVY_PROC_KB:-2000000}
limit_s=${SLICC_HEAVY_TIMEOUT:-900}
began=$(date +%s)
measure() {
  ps -axo pid=,ppid=,pgid=,rss=,lstart= | awk -v root="$child" -v state="$seen" '
    BEGIN { while ((getline line < state) > 0) { split(line, f, "\t"); known[f[1]] = f[2] } }
    {
      start = $5; for (i = 6; i <= NF; i++) start = start " " $i
      parent[$1] = $2; group[$1] = $3; rss[$1] = $4; began[$1] = start
    }
    END {
      sum = 0; max = 0; pids = ""
      for (p in parent) {
        q = p; hops = 0
        while (q != root && (q in parent) && hops++ < 64) q = parent[q]
        if (q != root && group[p] != root && known[p] != began[p]) continue
        sum += rss[p]; if (rss[p] > max) max = rss[p]; pids = pids " " p
        print p "\t" began[p] > (state ".new")
      }
      print sum, max, pids
    }'
  mv "$seen.new" "$seen" 2> /dev/null || : > "$seen"
}
stop() {
  trap - HUP INT TERM
  set -- $(measure)
  shift 2
  kill -9 "$@" 2> /dev/null
  wait "$child" 2> /dev/null
  rm -f "$seen" "$seen.new"
}
seen=$(mktemp "${TMPDIR:-/tmp}/slicc-heavy.XXXXXX")
perl -e 'setpgrp(0, 0); exec { $ARGV[0] } @ARGV or die "$ARGV[0]: $!\n"' "$@" &
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
  if [ $(($(date +%s) - began)) -gt "$limit_s" ]; then
    printf 'heavy.sh: stopped after %s s, the time limit (SLICC_HEAVY_TIMEOUT)\n' "$limit_s" >&2
    stop
    exit 124
  fi
  sleep 0.25
done
wait "$child"
status=$?
stop
[ -n "${SLICC_HEAVY_REPORT:-}" ] && printf 'heavy.sh: peak %s KB for the process tree\n' "$peak" >&2
exit "$status"
