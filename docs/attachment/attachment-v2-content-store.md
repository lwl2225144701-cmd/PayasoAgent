# 附件存储改造方案：内容寻址 + 原子发布 + 解码归一化（v2）

> 状态：P0 已实现（`2464ed6`）；P1 已实现（`4fdc33d`，sharp 归一化 + EXIF + 下采样 + 降级路径）；
> P2 已实现（`7151a07`，客户端下采样 + 请求体分层 2MB/12MB + 视觉三态强校验）。
> 变体缓存（`request-images/`）暂缓：入库对象已按模型预算归一化（≤2048²/≤4MiB），
> 等按模型差异化预算落地后再引入按 `(sha, 预算)` 的确定性变体。
> 关联现状：`7b9117b` 视觉全链路；对照 DSH `~/.dsh/attachments/v1` 管线

## 1. 现状问题（全部有代码定位）

| # | 问题 | 位置 |
|---|------|------|
| P1 | 同 run 同名附件互相覆盖：文件名 = `runId前8位 + basename`，后贴的顶掉先贴的，消息里旧 path 引用读到新内容 | `src/host/run-manager.ts:668-673` + `image-materialize.ts:84-102` |
| P2 | 非原子写入：`fs.writeFileSync` 直落最终路径，进程崩溃/断电留半截文件；并发写同名无保护 | `image-materialize.ts:99` |
| P3 | 字节不校验：只查 MIME 白名单 + 大小，坏图/改后缀的文件进到模型调用才炸 | `routes.ts requestAttachments` |
| P4 | 原图直发模型：8MB/5000px 的图原样进请求，烧请求体、烧 token、拖慢每轮物化 | `materializeMessagesForModel` |
| P5 | 每轮重新物化全部历史图片：同步 `readFileSync` + base64，多图长会话反复读盘 | `image-materialize.ts:loadImage` |
| P6 | 全局请求体上限 64KB→20MB：所有 JSON 端点攻击面变大 | `routes.ts:35 MAX_BODY_BYTES` |
| P7 | 用户显式关闭视觉无效：`resolveVision` 只实现 true 优先 | `run-manager.ts resolveVision` |

## 2. 目标 / 非目标

**目标**
1. 附件字节进**内容寻址库**：sha256 去重、永不覆盖、断电安全
2. 图片**解码校验 + EXIF 方向 + 按预算归一化**，归一化结果按 `(sha, 预算)` 确定性缓存，消除每轮重复解码
3. workspace 内**保留 agent 可见性**（产品语义：agent 能用文件工具操作用户贴的图）
4. 旧数据无缝兼容；请求体上限回调；Host 侧强制视觉校验

**非目标**
- 不引入 Lexical/Worker/RPC 等前端基建（textarea 直通保留）
- 不把字节搬出项目目录（`.data/` 即资产库根，不学 DSH 的家目录）
- 不回改历史会话的 transcript（旧 path 引用永远可读）

## 3. 方案总览

```
粘贴/上传(base64, ≤8MB/张)
        │  routes.ts requestAttachments（白名单+计数+大小，MIME 嗅探前置）
        ▼
┌─ 附件入库（Host）─────────────────────────────────────┐
│ 1. sha256 字节 → <项目根>/.data/attachments/v1/       │
│      objects/<sha前2>/<sha256>                        │
│ 2. sharp 解码校验（MIME↔字节一致、EXIF 方向、超限拒绝） │
│ 3. 归一化：>预算则下采样 ≤2048² / ≤4MiB               │
│ 4. tmp/ 暂存 → fsync → hardlink 原子发布 → chmod 0444  │
│ 5. 变体缓存 request-images/<2>/<sha(sha+budget)>       │
└───────────────────────────────────────────────────────┘
        │  workspace 可见性：hardlink（同卷）/ copy（跨卷回退）
        ▼
<workspaceRoot>/input/attachments/<runId前8>-<名>   （agent 可 read/操作）
        │
消息里 MessageImage { sha256, storePath, workspacePath?, mimeType, width/height }
        │  每轮调模型：优先读 request-images 变体（≤4MiB，免解码）
        ▼
materializeMessagesForModel → base64 → 模型
```

**关键取舍**：库存归一化后字节，workspace 内 hardlink 同一 inode——agent 看到的是同一份只读文件，零拷贝；跨卷（`SANDBOX_ROOT` 指到另一文件系统）自动回退为 copy。

## 4. 详细设计

### 4.1 存储布局

```
<项目根>/.data/attachments/v1/
├── objects/<sha256前2>/<sha256>          # 归一化后图片 + 原样文件，内容寻址，0444
├── request-images/<2>/<sha(sha256+budget)>  # 按预算转码的确定性变体缓存
├── files/<2>/<sha256>/<显示名>           # 普通文件的硬链接别名（可选，P2）
└── tmp/                                   # 发布前 staging，进程启动时清扫孤儿
```

- 分片目录（前 2 位）防单目录爆炸；`sha256` 用 `node:crypto` 流式计算
- 元数据不单独建库：`MessageImage` 自带 `sha256/width/height/originalDimensions`（对齐 DSH 的 ref 内联元数据思路）

### 4.2 原子发布协议（`attachment-store.ts` 新模块，~150 行）

```
write = (bytes) => {
  sha = sha256(bytes)
  final = objects/<2>/<sha>; if (exists(final)) return { sha, existed: true }
  tmp = tmp/<random>; fd = open(tmp, 'wx')
  write(fd, bytes); fsync(fd); close(fd)
  link(tmp, final)          # hardlink：同目录内原子；并发写者只有一个成功
  unlink(tmp); chmod(final, 0o444)
  return { sha, existed: false }
}
```

- 并发同 sha：`link` 原子性保证只有一个胜者，败者清理自己的 tmp（`EXDEV`/`EEXIST` 容忍）
- 启动清扫：删除 `tmp/` 内超过 1h 的孤儿
- `chmod 0444`：只读语义，硬链接别名共享权限（见 4.4 取舍说明）

### 4.3 sharp 依赖评估

| 候选 | 结论 |
|---|---|
| **sharp（选）** | 预编译 libvips 二进制，npm `optionalDependencies` 平台包自动装（darwin-arm64/x64、linux、win32 全覆盖），零编译；Node ≥22.5 兼容（0.34+）；EXIF 方向/元数据剥离/下采样/格式重编一行 API；本机解码速度比纯 JS 快 10-50 倍 |
| jimp | 纯 JS 但慢、大图内存高、EXIF 方向支持弱，5000px JPEG 解码可到秒级——归一化在请求热路径上不可接受 |
| sips/ImageMagick CLI | 系统依赖违背项目"零系统依赖"原则，跨平台不可控 |

**安装成本**：每平台 ~10-15MB（libvips 捆绑）。**降级策略（必须实现）**：`sharp` 安装失败或加载抛错 → 退化为"魔数嗅探校验（JPEG/PNG/GIF/WebP/BMP 签名）+ 不归一化"，即现行为，功能不回退、启动不阻塞（动态 `import('sharp')`，失败置 `sharpAvailable=false` 并打点日志）。

**归一化参数（P1 默认，常量集中在 `attachment-store.ts`）**
- 入库上限：单图 ≤20MiB、解码 ≤64M 像素、单边 ≤16384（超限拒绝该张，不致命）
- 归一化触发：总像素 >2048² 或编码后 >4MiB → 按比例下采样到 ≤2048²、质量 80 重编
- 格式：png→png（保 alpha）、jpeg→jpeg、webp→webp、gif **原样透传**（只做 metadata 校验不做重编，动图语义不破坏）
- 保留字段：`originalDimensions`（下采样时记录原图宽高）
- `rotate()` 应用 EXIF、`withMetadata()` 清地理位置等敏感元数据

### 4.4 workspace 可见性（产品语义保持）

- `writeAttachment` 后：`fs.linkSync(storeFile, <workspaceRoot>/input/attachments/<runId前8>-<safeName>)`（同卷零拷贝）；`EXDEV`/`EPERM` → `fs.copyFileSync` 回退
- **取舍**：hardlink 共享 inode，workspace 侧文件也是 0444 只读。agent 的 read/edit 语义：read 正常；edit 只读文件会失败——**预期行为**（用户贴的参考图不该被 agent 改写），文档里写明；若用户要改，工具先 copy 一份到 work/（read 工具已有 file 语义，不额外开发）
- 命名保留 `runId前8` 前缀（可读性）；**同名不再覆盖**——同名不同字节 = 不同 sha = 库里两个对象 + workspace 内报 `EEXIST` → 追加 `-2` 后缀

### 4.5 数据模型与物化（`MessageImage` 扩展）

```ts
// src/llm/llm.ts
interface MessageImage {
  mimeType: string;
  path?: string;          // workspace 相对路径（现有，继续支持旧数据）
  storePath?: string;     // 新：库内绝对路径（Host 私有，随 Run 上下文传递）
  sha256?: string;        // 新：内容键（去重/审计）
  data?: string;          // 仅本轮模型视图临时存在（现状不变）
  width?: number; height?: number; originalDimensions?: string; // 新
}
```

- `materializeMessagesForModel` 优先级：`storePath`（读 `request-images` 变体，无则读 objects 原件）→ `path`（workspace 相对，兼容旧数据）→ `data`（直通）
- 变体缓存命中 = 读 ≤4MiB 文件 + 无 sharp 解码；未命中 = 现场归一化并写缓存。**坑 P5 直接消除**：每轮 I/O 从"原图×N"降为"≤4MiB×N"
- canonical transcript / checkpoint / trace **仍然只存 path + sha**，base64 永不入库（现状语义不变）

### 4.6 上传通道与请求体回调（P2）

- Phase 1 服务端归一化后，**请求体里仍是原始 base64**（归一化发生在 Host 收到之后）——20MB 上限暂不动
- Phase 2 客户端下采样：`createImageBitmap` + `OffscreenCanvas` 压到 ≤2048²/≤4MiB 再转 base64 上传（纯浏览器 API，零新依赖；JSDOM 无 canvas，预算计算抽纯函数测）
- 完成后 `MAX_BODY_BYTES` 回调至 **2MB**，视觉请求单独白名单至 12MB（4 张 × ≤4MiB 归一化上限 + base64 膨胀 4/3）
- 普通文件独立上传端点（octet-stream + receiptId）评估为 P2 可选项，当前无普通文件上传需求，暂缓

### 4.7 Host 强制视觉校验（修坑 P7）

- `resolveVision` 改三态：`true > false（显式）> 注册表推断`——设置里 `vision: false` 时**强制剥离**所有图片并按现行为在 user 消息文本注明"图未发送"
- prompt 入口（`routes.ts` createRun/prompt）在 `resolveVision` 后对 `vision=false` 的请求直接拒绝带图附件（400），不再静默吞

## 5. 兼容与迁移

- **旧数据**：历史 transcript 里的 `path` 引用走 workspace 物化路径，永远可读——零迁移成本
- **新写入**：一律走库；`input/attachments/` 内旧文件不搬（留在原地继续被旧消息引用）
- **回填**（可选脚本 `scripts/backfill-attachments.ts`）：扫描 `sandbox/workspaces/*/input/attachments` 入库去重，只回填库不回改消息——默认不做，磁盘紧张再启用
- `ATTACHMENT_DIR`、`run-manager.ts:668` 的"文件名带前缀避免覆盖"注释语义更新为"可读性前缀，防覆盖由内容寻址保证"

## 6. 测试计划

| 套件 | 覆盖 |
|---|---|
| `tests/attachment-store.test.ts`（新） | sha 去重（同字节单文件）、并发同 sha 单胜者、tmp 孤儿清扫、0444 权限、EXDEV 回退 copy、EEXIST 改名追加后缀 |
| `tests/attachment-normalize.test.ts`（新，sharp 可用时跑） | EXIF 方向应用、超预算下采样到 ≤2048²/≤4MiB、坏字节拒绝、声明 MIME≠实际拒绝、png 保 alpha、gif 透传、originalDimensions 记录、sharp 缺失降级路径（mock 加载失败） |
| `tests/attachment-materialize.test.ts`（新） | storePath 优先、旧 path 回退、变体缓存命中（二次物化不再解码）、逃逸/超限单张跳过 + user 消息注明（回归现行为） |
| `tests/vision-flow.test.ts`（扩展现有 filesystem-tools 视觉用例） | 粘贴→入库→run→模型视图含归一化 image block；同名双图不覆盖；vision=false 强剥离 |
| `tests/host.test.ts`（改） | MAX_BODY_BYTES 回调后各端点行为；vision=false 带图 400 |

## 7. 分期与工作量

| 期 | 内容 | 预估 |
|---|---|---|
| **P0** | `attachment-store.ts`（内容寻址+原子发布+并发）+ 接入 `writeAttachmentFile` 调用点 + hardlink 可见性 + store 测试 | ~1 天 |
| **P1** | sharp 校验/归一化/变体缓存 + 降级路径 + `MessageImage` 扩展 + materialize 改造 + 测试 | ~1 天 |
| **P2** | 客户端下采样 + `MAX_BODY_BYTES` 回调 + Host 强制视觉校验（三态）+ 测试 | ~0.5 天 |

## 8. 风险与开放问题

1. **0444 硬链接在 workspace 侧的只读语义**是否影响用户直接改文件的心智（初步结论：预期行为，见 4.4）
2. sharp 平台包在离线/内网环境装不上 → 降级路径已设计，但要加一条启动日志让用户知道"归一化未生效"
3. gif 动图归一化不做（透传），超大 gif 仍可能占请求体——Phase 2 客户端下采样只压首帧或拒绝动图，待定
4. `SANDBOX_ROOT` 跨卷时 hardlink 回退 copy 有字节双份——量级可控（≤20MiB/张），不做进一步优化
5. read 工具产出的图（agent 截图等）是否也入库去重：建议 P1 一并接入 `storePath`（同一函数，改一处调用点）
