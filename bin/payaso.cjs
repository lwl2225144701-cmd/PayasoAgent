#!/usr/bin/env node
// 发布入口在加载应用前检查参数和 Node 版本；不读取当前目录 .env。
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error('PayasoAgent requires Node.js >= 22.5.0');
  process.exit(1);
}
const args = process.argv.slice(2);
const version = require('../package.json').version;
let port = process.env.PORT || '4500';
let openBrowser = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help') {
    console.log(
      'Usage: payaso-agent [--port 4500] [--no-open] [--version] [--help]\nData: ~/.payaso (override with absolute PAYASO_HOME).',
    );
    process.exit(0);
  }
  if (args[i] === '--version') {
    console.log(version);
    process.exit(0);
  }
  if (args[i] === '--no-open') {
    openBrowser = false;
    continue;
  }
  if (args[i] === '--port' && args[i + 1]) {
    port = args[++i];
    continue;
  }
  console.error(`Unknown or incomplete option: ${args[i]}. Use --help.`);
  process.exit(1);
}
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error('--port must be an integer between 1 and 65535');
  process.exit(1);
}
import('../dist/host/index.js')
  .then(({ startHost }) => startHost({ port: Number(port), openBrowser }))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
