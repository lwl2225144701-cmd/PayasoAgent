# @payaso/desktop —— PayasoAgent 桌面壳

把 PayasoAgent 套成一个「装完即用」的 macOS 应用：双击图标 → 自动拉起后端 → 直接进界面。

设计与调研见 [`docs/plans/desktop-client-electron-plan.md`](../../docs/plans/desktop-client-electron-plan.md)。

## 铁律

**壳不做业务**。所有交互都走 `http://127.0.0.1:4500`，与浏览器 / PWA 是同一套代码。
壳只负责四件事：起后端 → 等就绪 → 开窗口 → 干净退场。这样壳出问题时，用浏览器打开
同一个地址就能继续用。

## 运行形态（A1：自带官方 Node）

```text
PayasoAgent.app/Contents/Resources/
├── app.asar              壳自己的编译产物（main.js）
├── runtime/bin/node      官方 Node 运行时（scripts/fetch-node.mjs 生成）
└── app/                  后端整体（scripts/stage-backend.mjs 生成）
    ├── dist/             服务端编译产物
    ├── web/dist/         前端静态资源
    └── node_modules/     仅生产依赖
```

后端跑在**自带的官方 Node** 里（不是 Electron 自带的 Node）—— Electron 与官方 Node 的
ABI 不同，原生模块要重编；带一份官方 node 则与终端里的运行环境完全一致，风险为零。

## 常用命令

```bash
npm run setup       # 取官方 Node 运行时 + 生成图标 + 组装后端整体（首次必跑，需网络）
npm run dev         # 编译壳并直接起（开发用，指向仓库里的 dist/ 与 web/dist/）
npm run dist:mac    # 出 .app（release/mac-arm64/PayasoAgent.app），最快
npm run dist:dmg    # 出 DMG + ZIP（发给别人用；需要本机 hdiutil 可用）
```

产物都在 `release/` 下。`dist:mac` 出的 `.app` 可以直接拖进「应用程序」用。

## 发版本（CI 出 DMG）

**DMG 由 CI 打**——不是为了省事，而是「发布产物不该在开发机上随手构建」，
何况 `hdiutil` 在受限环境（如 Agent 沙箱）里会直接被拒。

**推一个 tag 就发版**：

```bash
git tag v0.2.0 && git push origin v0.2.0
```

然后去仓库 **Actions → Release (macOS DMG)** 看进度。构建成功后 Releases 页面自动挂上：

| 文件 | 用途 |
|---|---|
| `PayasoAgent-0.2.0-arm64-mac.dmg` | **安装包**（双击 → 拖到 Applications） |
| `PayasoAgent-0.2.0-arm64-mac.zip` | 分发包；**自动更新（期 3）用的就是这个格式** |

**只想构建、不想发版**：Actions 页面右上 `Run workflow`，填个版本号即可，
产物只进 artifacts，不创建 Release。

**版本号来源**（优先级从高到低）：手动填的 → tag 去掉 `v` → `package.json` 里的版本。
构建时会同步写进 `apps/desktop/package.json` 与 `package-lock.json`
（`scripts/sync-version.mjs`，避免 `npm ci` 因不同步而报错）。

**签名 / 公证**：CI 目前**不签**（凭据没配），下载到的 DMG 是未签名的 ——
别人首次打开会弹 Gatekeeper 警告，需要右键 → 打开。要正式分发就把这些配成仓库 secrets，
electron-builder 会自动签并公证；**凭据为空时自动跳过，不会让 CI 失败**。

| Secret | 用途 |
|---|---|
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Developer ID Application 证书（base64 的 .p12） |
| `CSC_INSTALLER_LINK` / `CSC_INSTALLER_KEY_PASSWORD` | Developer ID Installer（打 .pkg 时才要） |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | 公证（notarize） |

产物都在 `release/` 下。`dist:mac` 出的 `.app` 可以直接拖进「应用程序」用。

## 前置条件

| 要求 | 说明 |
|---|---|
| Node ≥ 22.5 | 仅**构建期**需要；装好之后用户机器上不需要 Node |
| 仓库已 `npm install` | `stage-backend.mjs` 要跑 `npm run build:server` / `build:web` |
| 网络 | `setup` 要下载官方 Node 运行时（约 50MB 压缩包），拉不动会自动回退 npmmirror |

## 已知边界

- **打包前 `dist/` 会过期**：`stage-backend.mjs` 已内置重新构建，不要绕过它直接拷 `dist/`。
- **端口占用**：如果 4500 已被占用（比如你自己起过 `npm run host`），壳会**复用**已有后端、
  并且退出时不杀它。
- **签名 / 公证**：本地自用不需要；发给别人才需要，细则见主文档 §5（标注未验证）。
- **Windows**：`scripts/fetch-node.mjs` 暂不支持，桌面包另议。
