#!/bin/sh
# Build: TypeScript, the Landlock shim (when its source exists), shipped transforms and console static files into dist/.
set -e
cd "$(dirname "$0")/.."
# a failed tsc leaves dist/ without these, so a stale build is never mistaken for a fresh one
rm -rf dist/transforms dist/console/static
tsc -b
# a deleted or renamed source leaves its compiled file behind (a stale test would keep running): drop it
find dist -name '*.js' ! -path 'dist/transforms/*' ! -path 'dist/console/static/*' | while read -r f; do
  s="src/${f#dist/}"
  [ -f "${s%.js}.ts" ] || rm -f "$f" "$f.map" "${f%.js}.d.ts" "${f%.js}.d.ts.map"
done
if [ -f native/landlock.c ]; then cc -O2 -Wall -o dist/hortus-landlock native/landlock.c; fi
if [ -d transforms ]; then cp -r transforms dist/transforms; fi
if [ -d src/console/static ]; then mkdir -p dist/console && cp -r src/console/static dist/console/static; fi
for b in dist/bin/*.js; do [ -f "$b" ] && chmod +x "$b"; done
exit 0
