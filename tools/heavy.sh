#!/bin/sh
slot="${HOME:-}/.bb/coord-bin/slicc-heavy"
if [ "${SLICC_HEAVY_SLOT:-}" = 1 ] && [ -z "${SLICC_HEAVY_SLOTTED:-}" ] && [ -x "$slot" ]; then
  SLICC_HEAVY_SLOTTED=1 exec "$slot" "$0" "$@"
fi
if [ "${SLICC_UNIT_SLOT:-1}" != 0 ] && [ -z "${SLICC_UNIT_HELD:-}" ] && [ -z "${SLICC_HEAVY_SLOTTED:-}" ] &&
  command -v lockf > /dev/null 2>&1; then
  slots=${SLICC_UNIT_SLOTS:-2}
  said=
  held=
  forward() {
    trap - HUP INT TERM
    [ -n "$held" ] && kill -TERM "-$held" 2> /dev/null && wait "$held" 2> /dev/null
    rm -f "$mark"
    exit "$1"
  }
  trap 'forward 129' HUP
  trap 'forward 130' INT
  trap 'forward 143' TERM
  while :; do
    n=1
    while [ "$n" -le "$slots" ]; do
      lock="/tmp/slicc-unit-$n.lock"
      mark=$(mktemp "${TMPDIR:-/tmp}/slicc-unit-mark.XXXXXX")
      SLICC_UNIT_HELD=1 perl -e '$SIG{INT} = $SIG{QUIT} = "DEFAULT"; setpgrp(0, 0); exec { $ARGV[0] } @ARGV or die "$ARGV[0]: $!\n"' \
        lockf -k -t 0 "$lock" /bin/sh -c 'rm -f "$0"; exec "$@" 2>&3' "$mark" "$0" "$@" \
        3>&2 2> /dev/null &
      held=$!
      wait "$held"
      status=$?
      held=
      if [ ! -e "$mark" ]; then
        exit "$status"
      fi
      rm -f "$mark"
      if [ "$status" -ne 75 ]; then
        printf 'heavy.sh: lockf could not take %s (exit %s)\n' "$lock" "$status" >&2
        exit "$status"
      fi
      n=$((n + 1))
    done
    if [ -z "$said" ]; then
      echo "heavy.sh: waiting for a unit slot" >&2
      said=1
    fi
    sleep 5
  done
fi
tree_kb=${SLICC_HEAVY_TREE_KB:-3000000}
proc_kb=${SLICC_HEAVY_PROC_KB:-2000000}
root_kb=${SLICC_HEAVY_ROOT_KB:-2800000}
[ "$root_kb" -lt "$proc_kb" ] && root_kb=$proc_kb
limit_s=${SLICC_HEAVY_TIMEOUT:-900}
moved=$(date +%s)
last=
measure() {
  ps -axo pid=,ppid=,pgid=,rss=,lstart= | awk -v root="$child" -v state="$seen" '
    BEGIN { while ((getline line < state) > 0) { split(line, f, "\t"); known[f[1]] = f[2] } }
    {
      start = $5; for (i = 6; i <= NF; i++) start = start " " $i
      parent[$1] = $2; group[$1] = $3; rss[$1] = $4; began[$1] = start
    }
    END {
      sum = 0; max = 0; top = 0; pids = ""
      for (p in parent) {
        q = p; hops = 0
        while (q != root && !((q in known) && known[q] == began[q]) && (q in parent) && hops++ < 64) q = parent[q]
        if (q != root && !((q in known) && known[q] == began[q]) && group[p] != root) continue
        sum += rss[p]; pids = pids " " p
        if (p == root) top = rss[p]
        else if (rss[p] > max) max = rss[p]
        print p "\t" began[p] > (state ".new")
      }
      print sum, max, top, pids
    }'
  mv "$seen.new" "$seen" 2> /dev/null || : > "$seen"
}
stop() {
  trap - HUP INT TERM
  set -- $(measure)
  shift 3
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
  top=${3:-0}
  shift 3 2> /dev/null || set --
  now="$*"
  if [ "$now" != "$last" ]; then
    last=$now
    moved=$(date +%s)
  fi
  [ "$sum" -gt "$peak" ] && peak=$sum
  if [ "$sum" -gt "$tree_kb" ] || [ "$max" -gt "$proc_kb" ] || [ "$top" -gt "$root_kb" ]; then
    printf 'heavy.sh: stopped at %s KB for the process tree, %s KB for one process, %s KB for the command itself (caps %s, %s and %s KB)\n' "$sum" "$max" "$top" "$tree_kb" "$proc_kb" "$root_kb" >&2
    stop
    exit 137
  fi
  if [ $(($(date +%s) - moved)) -gt "$limit_s" ]; then
    printf 'heavy.sh: stopped after %s s in which no process of the run started or ended (SLICC_HEAVY_TIMEOUT)\n' "$limit_s" >&2
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
