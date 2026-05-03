#!/usr/bin/env sh
ELECTRON_RUN_AS_NODE=1 npx electron "$(node -e "console.log(require.resolve('vitest/package.json').replace('package.json','vitest.mjs'))")" run "$@"
