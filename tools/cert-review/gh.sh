#!/usr/bin/env bash
set -euo pipefail
command -v gh > /dev/null && exit 0
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "::error::no gh release for $(uname -m)"; exit 1 ;;
esac
bin="$RUNNER_TEMP/bin"
mkdir -p "$bin"
v=$(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/repos/cli/cli/releases/latest | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).tag_name.replace(/^v/, "")')
cd "$bin"
curl -fsSL -O "https://github.com/cli/cli/releases/download/v$v/gh_${v}_linux_$arch.tar.gz" \
  -O "https://github.com/cli/cli/releases/download/v$v/gh_${v}_checksums.txt"
sha256sum -c "gh_${v}_checksums.txt" --ignore-missing
tar -xzf "gh_${v}_linux_$arch.tar.gz" --strip-components=2 "gh_${v}_linux_$arch/bin/gh"
echo "$bin" >> "$GITHUB_PATH"
