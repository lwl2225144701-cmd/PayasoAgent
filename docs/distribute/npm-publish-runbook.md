# npm 发布操作手册（payaso-agent）

状态：**已执行完成（2026-09-15）** —— payaso-agent@2.2.0 已发布至 npm（账号 pigsylu，2FA 走 Security Key passkey，浏览器 WebAuthn 确认），真实 `npx payaso-agent@2.2.0` 线上复验通过（registry 拉取、HTTP 200、capabilities 正常）。下文流程保留作为后续发版参考；前置验收记录见 docs/distribute/npx-distribution-plan.md。

## 0. 发布决策（人工确认项）

| 项 | 现状 | 待确认 |
|---|---|---|
| 包名 | payaso-agent（registry 查询空闲） | 确认使用 |
| 版本 | 2.2.0（package.json 已是） | 确认 |
| license | **缺失** | 建议 MIT，发布前必须补上 |
| 可见性 | unscoped 包默认 public | 确认接受公开 |
| 发布账号 | 本机未登录 | 需注册/登录，建议开启 2FA |

## 1. 账号准备（一次性）

    npm whoami                        # 报 ENEEDAUTH 说明未登录
    # 没有账号：https://www.npmjs.com/signup 注册（建议开启 2FA）
    npm login                         # 浏览器授权或输入 OTP
    npm whoami                        # 应输出用户名

## 2. 发布前准备（每次发布）

    cd /Users/luweiliang/Downloads/myProject/PayasoAgent

    # 2.1 license（首次发布前补一次）：package.json 增加 "license": "MIT"（可选：根目录放 LICENSE 文件）

    # 2.2 确认包名/版本/白名单
    grep -E '"name"|"version"|"license"|"files"' package.json

    # 2.3 全量构建 + 打包（prepack 自动执行 build：server + web + 第三方许可）
    npm run build
    npm pack                          # 生成 payaso-agent-2.2.0.tgz

    # 2.4 包内容终检（发布前最后一道安全网）
    tar -tzf payaso-agent-2.2.0.tgz | grep -E '\.env$|\.log$|checkpoints|\.data/|tests/'   # 应无输出
    tar -tzf payaso-agent-2.2.0.tgz | wc -l          # 约 175 文件
    grep -rE 'sk-[A-Za-z0-9]{20}' dist/ web/dist/ bin/   # 无密钥命中

## 3. 干净目录冒烟（发布前最后一次）

    VDIR=$(mktemp -d) && cp payaso-agent-2.2.0.tgz "$VDIR/" && cd "$VDIR"
    npm install payaso-agent-2.2.0.tgz --cache "$VDIR/.npm-cache"
    node node_modules/payaso-agent/bin/payaso.cjs --no-open --port 4700 &
    curl -sf -o /dev/null http://127.0.0.1:4700/ && echo SMOKE_OK
    kill %1

## 4. 发布

    npm publish                       # unscoped 首次发布默认 public
    # 若账号开了 2FA，按提示输入 OTP，或：npm publish --otp=123456

发布后立即核对：

    npm view payaso-agent version dist.tarball    # 应为 2.2.0
    # 浏览器打开 https://www.npmjs.com/package/payaso-agent 检查 README/许可/文件列表

## 5. 线上复验（§5 第 4 步的"真实 npx"，不能省）

    VDIR2=$(mktemp -d) && cd "$VDIR2"
    npx payaso-agent@2.2.0 --no-open --port 4701
    # 验证：启动日志正常 → 浏览器打开 http://127.0.0.1:4701 → 设置/工作区可用
    npx payaso-agent@latest --version

注意：本机 npm 缓存里已有同名 tarball 时 npx 可能命中本地缓存；要绝对真实可换一个全新目录并加 --yes，或先 npm cache clean --force（影响面大，慎用）。

## 6. 发布后收尾

    git checkout main && git merge --no-ff feat/npx-distribution   # 或走 PR 合并
    git tag v2.2.0 && git push origin main --tags

后续版本迭代：npm version patch|minor|major（自动改 package.json 并打 tag）→ 重复 §2~§5。

## 7. 应急

| 场景 | 操作 | 限制 |
|---|---|---|
| 发错版本需撤回 | npm unpublish payaso-agent@2.2.0 | 发布 72 小时内；撤过的版本号不能复用，需 bump |
| 有缺陷但不想撤 | npm deprecate payaso-agent@2.2.0 "原因" 并立即发修复版 | — |
| dist-tag 发错 | npm dist-tag rm payaso-agent latest 后对正确版本 add | — |
| 包名被抢注风险 | 正式发布前不要在公开渠道透露包名；registry 名字先到先得 | — |

## 检查点小结（按顺序打勾）

- [ ] npm 账号已登录（npm whoami 有输出）
- [ ] license 已补（package.json + 可选 LICENSE 文件）
- [ ] npm run build 成功、回归全绿
- [ ] npm pack 产物内容终检无密钥/杂文件
- [ ] 干净目录冒烟通过
- [ ] npm publish 成功、npmjs.com 页面正常
- [ ] **真实 npx payaso-agent@2.2.0 复验通过**（方案明确：本地 tarball 验证不算线上分发完成）
- [ ] 合并 feat/npx-distribution → main，打 v2.2.0 tag
