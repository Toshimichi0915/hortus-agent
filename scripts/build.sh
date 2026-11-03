#!/bin/sh
# Build: TypeScript, the Landlock shim (when its source exists), shipped transforms and console static files into dist/.
set -e
cd "$(dirname "$0")/.."
tsc -b
if [ -f native/landlock.c ]; then cc -O2 -Wall -o dist/hortus-landlock native/landlock.c; fi
if [ -d transforms ]; then rm -rf dist/transforms && cp -r transforms dist/transforms; fi
if [ -d src/console/static ]; then mkdir -p dist/console && rm -rf dist/console/static && cp -r src/console/static dist/console/static; fi
for b in dist/bin/*.js; do [ -f "$b" ] && chmod +x "$b"; done
exit 0
