// 发布时保留安装依赖中的许可文本，含 Web 构建依赖；不读取用户运行数据。
import fs from 'node:fs';
import path from 'node:path';

const entries = new Map();
for (const base of ['.', 'web']) {
  const lock = JSON.parse(fs.readFileSync(path.join(base, 'package-lock.json'), 'utf8'));
  for (const relative of Object.keys(lock.packages)) {
    if (!relative) continue;
    const dir = path.join(base, relative);
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue; // 当前平台不安装的可选包
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const key = `${pkg.name}@${pkg.version}`;
    if (entries.has(key)) continue;
    const licenses = fs
      .readdirSync(dir)
      .filter(
        (name) =>
          /^(licen[sc]e|copying|notice)(\.|$)/i.test(name) &&
          fs.statSync(path.join(dir, name)).isFile(),
      );
    entries.set(
      key,
      `## ${key}\n\nDeclared license: ${JSON.stringify(pkg.license ?? 'See package source')}\n\n${licenses.map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n\n')}`,
    );
  }
}
fs.writeFileSync(
  'THIRD_PARTY_NOTICES.md',
  '# Third-party notices\n\nBuild and runtime dependency notices from installed packages.\n\n' +
    [...entries.values()].join('\n\n---\n\n'),
);
