# i18n 约定（前端文案本地化）

> 目标：界面文案跟随 `preferences.LanguageMode`（`zh-CN` / `en-US`）切换。
> **注释保持中文**（仓库约定），只有**用户可见文案**进消息表。

## 1. 目录与职责

```
web/src/i18n/
  index.tsx              React 层：I18nProvider + useI18n()
  translate.ts           纯函数层：translate(language, key, params) / translator(language)
  messages/
    index.ts             聚合（唯一导出 MessageKey 的地方）
    types.ts             MessageEntry / MessageLanguage / MessageTable
    common.ts            跨领域短词（确定/取消、状态词、相对时间…）
    app.ts composer.ts settings.ts shell.ts timeline.ts widgets.ts
                        各领域消息表，key 以领域名做前缀
```

一个 key 的形态：

```ts
'docs.example.title': { 'zh-CN': '示例', 'en-US': 'Example' },
```

**两种语言都必须有**（类型上强制），英文侧不得残留中文
（`tests/frontend-i18n-coverage.test.ts` 会把中英混排抄错的情况抓出来）。

## 2. 怎么用

组件（React）：

```tsx
import { useI18n } from '../../i18n';
const { t, language } = useI18n();
return <button title={t('composer.send')}>{t('common.cancel')}</button>;
```

插值：消息里写 `{count}`，调用处传 `{ count: 3 }`。

纯函数模块（无 React，被确定性测试直接调用）：

```ts
import { translate, translator, type Translate } from '../../i18n/translate';
// 语言必须是入参，不能是隐藏的模块级状态，否则测试要改全局、并行用例互相污染
export function formatSomething(x: number, language: LanguageMode = 'zh-CN'): string
```

**末位可选参数默认 `zh-CN`**，这样既有调用点与测试不传也照旧（现有测试断言的是中文输出）。

日期/数字格式：`toLocaleTimeString(language, …)` —— `language` 本身可当 locale 用。

## 3. key 命名

- 前缀 = 领域：`app.` `composer.` `settings.` `shell.` `timeline.` `widgets.` `common.`
- 层级用点号，语义化而不是抄原文：`settings.models.deleteConfirm` 而不是 `settings.models.queDingShanChu`
- 复用的短词放 `common.`（确定/取消/关闭/状态词/相对时间），领域内专属的放各自文件

## 4. 覆盖范围

组件里**所有**用户可见文案：JSX 文本、`title`、`aria-label`、`placeholder`、`alt`、
确认弹窗、toast、`alert`、错误消息前缀、单位与状态词、空态文案。

## 5. 不该翻译的（豁免）

确实不是展示文案的，在该行或上一行加注释，注明理由：

```ts
// i18n-exempt: 语言自称，英文界面下也显示「中文」
<option value="zh-CN">中文</option>
```

典型豁免：语言选择器里的语言自称、`/permission 只读` 这类**用户输入别名**、
纯开发期日志（`console.warn`，非界面文案）。

## 6. 自检（改动后必须全绿）

```bash
npx tsx tests/helpers/i18n-check.ts <改过的文件…>   # 用户可见中文必须为 0
cd web && npx tsc --noEmit                            # 类型（key 写错会在这里报）
npx biome check --write <改过的文件…>                 # 格式化
```

`npm run test:all` 里的 `frontend-i18n-coverage` 是总闸门：它扫描整个 `web/src`，
只要还有一处写死中文就红。
