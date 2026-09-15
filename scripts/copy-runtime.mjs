// TypeScript 不会复制 runner，显式保留相对路径。
import { copyFileSync } from 'node:fs';

copyFileSync(
  new URL('../src/sandbox/win-acl-runner.mjs', import.meta.url),
  new URL('../dist/sandbox/win-acl-runner.mjs', import.meta.url),
);
