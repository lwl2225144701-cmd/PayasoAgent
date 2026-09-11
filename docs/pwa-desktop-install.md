# PayasoAgent PWA 桌面入口方案

状态：**已实施并安装验收通过（2026-09-11，已推送 GitHub）**。目标：用户先手动启动 PayasoAgent Host，再从桌面、启动台或
任务栏点击 PayasoAgent 图标，以独立窗口打开 `http://localhost:4500`。

实施验证结果：`npm run build:web` 通过；启动 Host 后 `/manifest.json` 200 +
`application/json; charset=utf-8`、两张图标 200 + 实际字节尺寸 192×192 / 512×512；
`npx tsc --noEmit` 无错误；`npm run test:all` 82 套件全绿（16.7s）。
真实 Chrome 安装验收（§6）已由用户完成：地址栏安装图标出现，安装成功。

---

## 0. 结论

本方案只解决一件事：**把现有 Web UI 安装成 Chrome 独立窗口入口**。

用户使用流程：

```text
终端启动 Host → 点击桌面 PayasoAgent 图标 → Chrome 独立窗口打开应用
```

已接受的边界：

- PWA **不负责启动 Node Host**；点击图标前必须先启动 Host；
- Host 固定使用 `http://localhost:4500`，安装后不要切换成 `127.0.0.1` 或其他端口；
- Host 未启动时，PWA 窗口会显示无法连接，启动 Host 后刷新即可；
- 不做离线对话、不做自动更新器、不引入 Electron/Tauri；
- 不使用 Service Worker，避免给 SSE、开发环境和静态缓存增加无必要的状态；
- 目标浏览器限定为桌面版 Google Chrome，**地址栏显示安装图标是硬验收条件**。应用负责满足
  Chrome 的安装推广条件，但不能用页面代码强制绘制浏览器地址栏按钮。

改动保持在 **5 个产品文件**：

```text
web/public/manifest.json
web/public/icon-192.png
web/public/icon-512.png
web/index.html
src/host/routes.ts        ← 实施时新增的一行例外，见 §2.1
```

不改 API、SSE、会话恢复和前端业务代码。原方案写的是「不修改 Host」，实施时发现静态服务的
缓存策略会卡死 manifest 更新，补了一行例外（§2.1）；这是对原约定的修正，不是违背。

## 1. 为什么这个方案能满足目标

Chrome 安装 Web 应用需要 manifest、应用名称、192/512 图标、`start_url`、独立窗口显示模式，
并要求页面来自 HTTPS 或 `localhost`/`127.0.0.1`。

PayasoAgent 已具备其余前提：

- 生产形态由 Host 在 4500 端口直接提供 `web/dist`；
- 页面、API、EventSource 全部同源；
- `http://localhost:4500` 属于浏览器认可的本地可信环境；
- `payaso.lastSessionId` 已负责恢复上次会话；
- 页面已有与当前深色主题一致的 `theme-color: #0f1115`。

Service Worker 不是当前浏览器的安装硬条件。这个功能不需要离线能力，加入 SW 只有缓存和
SSE 回归风险，因此第一期明确不做。

## 2. Manifest 设计

新增 `web/public/manifest.json`：

```json
{
  "id": "/",
  "name": "PayasoAgent",
  "short_name": "PayasoAgent",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "prefer_related_applications": false,
  "background_color": "#0f1115",
  "theme_color": "#0f1115",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

字段取舍：

- `id: "/"`：固定应用身份，避免以后调整启动地址时被识别成另一个应用；
- `start_url: "/"`：启动后由现有 `payaso.lastSessionId` 恢复上次会话；
- `scope: "/"`：整个 PayasoAgent 同源页面都属于独立窗口；
- `display: "standalone"`：隐藏地址栏和普通浏览器标签栏；
- `prefer_related_applications: false`：明确由 Chrome 安装当前 Web 应用；
- 不加入截图、快捷方式、文件协议等二期字段。

文件使用 `.json` 而不是 `.webmanifest`，因为 Host 已正确返回 `.json` 的 MIME 类型，避免为
一个静态文件修改 `src/host/routes.ts`。

### 2.1 Host 静态服务的 manifest 缓存策略（实施期补充）

Host 的 `serveStatic` 对所有非 HTML 静态文件发 `Cache-Control: public, max-age=31536000,
immutable`。这对带内容 hash 的 Vite 产物（`assets/*`）是正确设计，但 `manifest.json` 是
**不带 hash 的固定路径**：一旦按原策略发出，浏览器会缓存一年，之后修改 manifest（加图标、
换 display 等）Chrome 拿不到新内容，已安装应用的元数据也就不会更新。

因此 `src/host/routes.ts` 的 `serveStatic` 增加一个条件：`manifest.json` 与 `.html` 同样
发 `Cache-Control: no-cache`（协商缓存，每次 revalidate）。这是 Host 侧唯一的改动，
一行，不影响 API 与其他静态资源的既有行为。

## 3. 图标设计

图标从现有 `web/public/payaso-mark.png` 生成两档：

- `web/public/icon-192.png`：192×192；
- `web/public/icon-512.png`：512×512。

生成规则：

1. 新建 `#0f1115` 的不透明正方形画布；
2. 原图按 `contain` 等比缩放，不裁切鹿角和轮廓；
3. 主体居中并保留约 10% 安全边距（内容盒为目标的 80%）；
4. 分别输出 192×192 和 512×512 PNG；
5. 不声明 `maskable`，除非后续专门制作并验证安全区版本。

实施记录：`sips` 的 `--padToHeightWidth` 对近方形源图行为不可控且在本机运行环境写不了
临时文件，最终用零依赖 Node 脚本实现（box-filter 面积平均缩放 + 预乘 alpha 合成到
`#0f1115` 画布）。验证：内容区 410×366 / 154×138，宽高比 1.120 与源图 1327×1185
完全一致（无拉伸），视觉检查鹿角完整居中。

这里禁止“强制拉伸成正方形”或“直接居中裁方”，两种方式都会破坏现有标志比例。

## 4. 页面接入

只在 `web/index.html` 的 `<head>` 增加：

```html
<link rel="manifest" href="/manifest.json" />
```

不注册 Service Worker，不修改 `main.tsx`，不监听 `beforeinstallprompt`。满足 Chrome 的安装推广
条件后，由桌面版 Chrome 在地址栏显示安装图标；界面内不再增加一套重复的安装按钮。

这里把目标环境限定为桌面版 Google Chrome 普通窗口。验收前应确保应用尚未安装，并在页面完成
至少一次点击且累计停留至少 30 秒；Chrome 的安装资格检测也可能需要数秒。若这些前提满足后地址栏
仍不显示图标，本期验收失败，应先用 Application 面板检查 manifest/installability 原因。

## 5. 与现有功能的关系

| 功能 | 影响 | 原因 |
|---|---|---|
| SSE 流式回复 | 无影响 | 没有 Service Worker，不介入任何网络请求 |
| Snapshot 请求 | 无影响 | 仍走当前同源 `fetch` |
| 会话恢复 | 正常 | 安装窗口与同一 Chrome Profile 下的标签页使用同一 origin 存储 |
| 侧栏展开 | 正常 | 继续使用现有恢复后的前端状态逻辑 |
| Host 鉴权 | 无影响 | 页面 origin 仍是 `http://localhost:4500` |
| Vite 开发模式 | 无影响 | 只多一个 manifest 链接，没有 SW 污染 5173 |
| Markdown/Mermaid | 无影响 | 不涉及渲染链路 |

端口是应用身份的一部分：

```text
http://localhost:4500 ≠ http://127.0.0.1:4500 ≠ http://localhost:4501
```

安装和日常使用都统一访问 `http://localhost:4500`。

## 6. 用户操作流程

首次安装：

1. 在项目目录执行 `npm start`，完成 Web 构建并启动 Host；
2. Chrome 打开 `http://localhost:4500`；
3. 在页面点击一次并停留至少 30 秒，等待地址栏右侧出现安装图标；
4. 点击地址栏安装图标并选择“安装 PayasoAgent”；
5. 确认后生成独立窗口及桌面/启动台/任务栏入口；
6. 在独立窗口发送一条消息，确认功能正常。

验收记录（2026-09-11）：用户已完成真实安装 —— 地址栏出现安装图标并成功安装为独立窗口应用。
Chrome 的 installability 检测（manifest 字段完整性、图标尺寸、standalone、安全上下文）全部
真实通过。

日常启动：

1. 先在项目目录执行 `npm run host`；
2. 再点击 PayasoAgent 桌面图标；
3. 若先点了图标并看到连接失败，启动 Host 后刷新窗口。

Web 代码发生变化后，应先重新执行 `npm run build:web`，再启动 Host。

## 7. 实施步骤

1. 从 `payaso-mark.png` 生成两张方形图标；
2. 新增 `web/public/manifest.json`；
3. 在 `web/index.html` 引用 manifest；
4. 执行 `npm run build:web`；
5. 启动 Host 并做真实 Chrome 安装验收；
6. 执行全量确定性测试，确认既有功能无回归。

不顺手增加 SW、安装按钮、离线页面、自动启动脚本或桌面打包能力。

## 8. 验收清单

### 静态资源

- `GET /manifest.json` 返回 200；
- `Content-Type` 为 `application/json; charset=utf-8`；
- `Cache-Control` 为 `no-cache`（见 §2.1，不能是 `immutable`）；
- manifest 可解析且无 Chrome Application 面板错误；
- 两张图标真实尺寸分别为 192×192、512×512，显示无拉伸、无裁切。

### 安装

- 在桌面版 Chrome 普通窗口中，应用未安装、页面已点击且停留至少 30 秒后，地址栏显示安装图标；
- 必须从地址栏图标发起安装，菜单入口不作为本需求的替代验收；
- 安装名称和图标正确；
- 安装后以独立窗口打开，没有普通地址栏和标签栏；
- macOS 启动台/Dock 或 Windows 开始菜单/任务栏出现入口。

### 现有功能回归

- 先启动 Host，再点击桌面图标，页面正常打开；
- 刷新后恢复上次会话；
- 侧栏展开到当前会话所在工作区；
- 发送消息后 SSE 流式回复正常；
- Markdown、代码块和 Mermaid 显示正常；
- `npm run build:web`、`npx tsc --noEmit`、`npm run test:all` 全绿。

### 边界验收

- Host 未启动时允许显示连接失败；
- Host 启动后刷新可以恢复；
- 不承诺离线对话；
- 不承诺点击 PWA 图标自动启动 Host；
- Chrome 地址栏属于浏览器 UI，应用只能满足其公开的安装推广条件；目标 Chrome 若因版本、策略或
  Profile 状态隐藏入口，则该运行环境不通过验收，页面代码本身无法覆盖该行为。

## 9. 后续升级条件

只有出现明确需求时再进入二期：

- 需要应用内“安装”按钮：再接 `beforeinstallprompt`；
- 需要点击图标自动启动 Host：重新评估轻量启动器、Tauri 或 Electron；
- 需要 Host 不运行时仍显示离线壳：单独设计 Service Worker 缓存与升级策略；
- 目标 Chrome 在安装推广条件满足后仍不显示地址栏图标：先记录浏览器版本、Profile/策略状态和
  Application 面板原因；Service Worker 不是当前硬条件，不能把“加 SW”当成默认修复。

## 10. 参考资料

- MDN：Making PWAs installable  
  https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
- web.dev：Add a web app manifest  
  https://web.dev/articles/add-manifest
- web.dev：Web app manifest  
  https://web.dev/learn/pwa/web-app-manifest
- web.dev：What does it take to be installable?  
  https://web.dev/articles/install-criteria
- web.dev：PWA installation  
  https://web.dev/learn/pwa/installation
