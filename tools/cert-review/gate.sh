#!/usr/bin/env bash
set -uo pipefail
mode=pass
case "${1:-}" in
  --either) mode=either; shift ;;
  --evidence) mode=evidence; shift ;;
esac
name=${1:?gate.sh [--either|--evidence] NAME COMMAND...}
shift
[ "$#" -gt 0 ] || { echo "::error title=$name::gate.sh got no command for $name"; exit 70; }
log=$(mktemp)
"$@" | tee "$log"
code=${PIPESTATUS[0]}
line=$(awk -v p="$name: " 'index($0, p) == 1 { rest = substr($0, length(p) + 1); if (rest ~ /^(PASS|FAIL)( |$)/) last = $0 } END { print last }' "$log")
rm -f "$log"
if [ -z "$line" ]; then
  echo "::error title=$name::$name printed no PASS or FAIL verdict (exit $code): its silence is not a pass"
  exit 70
fi
[ "$mode" = evidence ] && exit 0
[ "$mode" = either ] && exit "$code"
case "$line" in
  "$name: PASS"*)
    [ "$code" -eq 0 ] && exit 0
    echo "::error title=$name::$name said PASS but exited $code"
    exit "$code"
    ;;
esac
[ "$code" -ne 0 ] && exit "$code"
echo "::error title=$name::$name said FAIL but exited 0"
exit 1
