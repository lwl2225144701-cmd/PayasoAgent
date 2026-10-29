import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Windows helper must be compiled on Windows');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiler = path.join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET',
  'Framework64',
  'v4.0.30319',
  'csc.exe',
);
if (!existsSync(compiler)) throw new Error(`Missing .NET Framework compiler: ${compiler}`);
const result = spawnSync(
  compiler,
  [
    '/nologo',
    '/target:exe',
    '/platform:x64',
    '/optimize+',
    '/warnaserror+',
    '/reference:System.Web.Extensions.dll',
    `/out:${path.join(root, 'build', 'PayasoUpdate.exe')}`,
    path.join(root, 'windows', 'PayasoUpdate.cs'),
  ],
  { stdio: 'inherit', shell: false },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
