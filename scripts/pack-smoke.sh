#!/usr/bin/env bash
# Packaging smoke test (run after `npm run build`): installs the real npm
# tarball into a clean temp project and checks that
#   1) both bins run,
#   2) the Node API imports and exposes its functions,
#   3) importing the API writes NOTHING to stdout (library contract),
#   4) TypeScript consumers resolve the bundled type declarations.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

tarball="$(cd "$root" && npm pack --silent --pack-destination "$work" | tail -n1)"
cd "$work"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "./$tarball" typescript@5 >/dev/null

echo "bin ctun:        $(npx --no-install ctun --version)"
echo "bin cloudtunnel: $(npx --no-install cloudtunnel --version)"

node --input-type=module -e "
  const m = await import('@iamken/cloudtunnel');
  for (const fn of ['up', 'ls', 'down', 'url']) if (typeof m[fn] !== 'function') { console.error('missing export', fn); process.exit(1); }
" > stdout.txt
bytes="$(wc -c < stdout.txt)"
if [ "$bytes" != "0" ]; then echo "API import wrote $bytes bytes to stdout"; exit 1; fi
echo "api import:      ok (stdout 0 bytes)"

cat > check.ts <<'TS'
import { up, type Tunnel, type TunnelSession } from "@iamken/cloudtunnel";
const f: (s: string) => Promise<TunnelSession> = (s) => up(s, { ttl: "2h", replace: false });
const t: Tunnel["state"] = "up";
void f; void t;
TS
npx --no-install tsc --noEmit --strict --module nodenext --moduleResolution nodenext --skipLibCheck false check.ts
echo "types:           ok"
