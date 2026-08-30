import assert from "node:assert/strict";
import { stripThinkTags } from "../web/src/format.js";

const cases = [
  {
    name: "完整 think 标签与最终答案分离",
    input: "<think>内部过程</think>最终答案",
    visible: "最终答案",
    thinking: "内部过程",
  },
  {
    name: "流式未闭合 think 不泄漏到正文",
    input: "前置正文<think>尚未完成的过程",
    visible: "前置正文",
    thinking: "尚未完成的过程",
  },
  {
    name: "多个 think 块按顺序聚合",
    input: "<think>一</think>答案<think>二</think>",
    visible: "答案",
    thinking: "一\n\n二",
  },
  {
    name: "普通 Markdown 原样保留",
    input: "### 标题\n\n- 条目",
    visible: "### 标题\n\n- 条目",
    thinking: null,
  },
];

for (const item of cases) {
  const actual = stripThinkTags(item.input);
  assert.equal(actual.visible, item.visible, `${item.name}: visible`);
  assert.equal(actual.thinking, item.thinking, `${item.name}: thinking`);
  console.log(`  [PASS] ${item.name}`);
}

console.log(`\nFrontend format tests: ${cases.length} PASS / 0 FAIL`);
