import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sourceRoot = path.join(projectRoot, 'src');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(item));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(item);
  }
  return files;
}

function relativeImports(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const imports: string[] = [];
  const pattern = /(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

function resolveSourceImport(fromFile: string, specifier: string): string | null {
  const raw = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [raw, raw.replace(/\.js$/, '.ts'), `${raw}.ts`, path.join(raw, 'index.ts')];
  return (
    candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ??
    null
  );
}

const files = sourceFiles(sourceRoot);
const innerLayerFiles = files.filter((file) => {
  const rel = path.relative(sourceRoot, file);
  return rel.startsWith(`runtime${path.sep}`) || rel.startsWith(`tools${path.sep}`);
});

for (const file of innerLayerFiles) {
  for (const specifier of relativeImports(file)) {
    const target = resolveSourceImport(file, specifier);
    assert.ok(
      target === null || !target.startsWith(path.join(sourceRoot, 'host') + path.sep),
      `${path.relative(projectRoot, file)} must not depend on Host: ${specifier}`,
    );
  }
}

const hostServices = files.filter((file) => {
  const rel = path.relative(path.join(sourceRoot, 'host'), file);
  return !rel.includes(path.sep) && /(?:-service|-coordinator)\.ts$/.test(rel);
});
for (const file of hostServices) {
  for (const specifier of relativeImports(file)) {
    const target = resolveSourceImport(file, specifier);
    assert.notEqual(
      target,
      path.join(sourceRoot, 'host', 'run-manager.ts'),
      `${path.relative(projectRoot, file)} must not depend on RunManager facade`,
    );
  }
}

const graph = new Map<string, string[]>();
for (const file of files) {
  graph.set(
    file,
    relativeImports(file)
      .map((specifier) => resolveSourceImport(file, specifier))
      .filter((target): target is string => target?.startsWith(sourceRoot) === true),
  );
}

const visiting = new Set<string>();
const visited = new Set<string>();
const stack: string[] = [];
function visit(file: string): void {
  if (visited.has(file)) return;
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    const cycle = [...stack.slice(start), file].map((item) => path.relative(projectRoot, item));
    assert.fail(`Source import cycle: ${cycle.join(' -> ')}`);
  }
  visiting.add(file);
  stack.push(file);
  for (const target of graph.get(file) ?? []) visit(target);
  stack.pop();
  visiting.delete(file);
  visited.add(file);
}
for (const file of files) visit(file);

console.log('Architecture boundary tests: PASS');
