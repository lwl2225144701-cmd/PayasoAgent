import assert from 'node:assert/strict';
import { splitStreamingMarkdown } from '../web/src/components/streaming-markdown.js';

// 契约：流式分块是「实时 Markdown 渲染」的性能前提。
// 它必须保证三件事：
//   1. 块边界只落在「fence 之外的空行」—— 代码块内部的空行绝不能切开代码块；
//   2. 停在未闭合 fence 内时，fence 源码单独返回，绝不混进 Markdown（否则流到
//      一半的 mermaid 会被当成完整图表渲染并报语法错）；
//   3. 每帧至多只有最后一个块会变 —— 这是「每帧只重解析一个块 + 尾部」的依据。

type Case = { name: string; run: () => void };

const cases: Case[] = [
  {
    name: '空文本 → 无块、无尾部、无未闭合 fence',
    run: () => {
      const split = splitStreamingMarkdown('');
      assert.deepEqual(split, { blocks: [], tail: '', openFence: '' });
    },
  },
  {
    name: '没有空行 → 整段都是尾部（还没定型）',
    run: () => {
      const split = splitStreamingMarkdown('正在写的一句话');
      assert.deepEqual(split.blocks, []);
      assert.equal(split.tail, '正在写的一句话');
    },
  },
  {
    name: '空行终止块 → 块定型，其余留在尾部',
    run: () => {
      const split = splitStreamingMarkdown('第一段\n\n第二段还没写完');
      assert.deepEqual(split.blocks, ['第一段']);
      assert.equal(split.tail, '第二段还没写完');
    },
  },
  {
    name: '连续空行不产生空块',
    run: () => {
      const split = splitStreamingMarkdown('甲\n\n\n\n乙\n\n');
      assert.deepEqual(split.blocks, ['甲', '乙']);
      assert.equal(split.tail, '');
    },
  },
  {
    name: '代码块内部的空行不切开代码块（核心）',
    run: () => {
      const split = splitStreamingMarkdown('```js\nconst a = 1;\n\nconst b = 2;\n```\n\n后面');
      assert.deepEqual(split.blocks, ['```js\nconst a = 1;\n\nconst b = 2;\n```']);
      assert.equal(split.tail, '后面');
    },
  },
  {
    name: '未闭合 fence → 前缀冻结成块，fence 源码单独返回、不进 Markdown',
    run: () => {
      const split = splitStreamingMarkdown('前言\n\n```mermaid\ngraph TD\nA-->B');
      assert.deepEqual(split.blocks, ['前言']);
      assert.equal(split.tail, '');
      assert.equal(split.openFence, '```mermaid\ngraph TD\nA-->B');
    },
  },
  {
    name: '全文就是一段未闭合 fence → 没有可冻结的前缀',
    run: () => {
      const split = splitStreamingMarkdown('```js\nconst a');
      assert.deepEqual(split.blocks, []);
      assert.equal(split.openFence, '```js\nconst a');
    },
  },
  {
    name: 'fence 闭合后不再是 openFence',
    run: () => {
      const split = splitStreamingMarkdown('```js\ncode\n```\ntail');
      assert.equal(split.openFence, '');
      assert.deepEqual(split.blocks, []);
      assert.equal(split.tail, '```js\ncode\n```\ntail');
    },
  },
  {
    name: '波浪号 fence 同样跟踪',
    run: () => {
      const split = splitStreamingMarkdown('~~~\ncode\n\nmore\n~~~\n\n尾声');
      assert.deepEqual(split.blocks, ['~~~\ncode\n\nmore\n~~~']);
      assert.equal(split.tail, '尾声');
      assert.equal(split.openFence, '');
    },
  },
  {
    name: '短 fence 不能闭合长 fence',
    run: () => {
      const split = splitStreamingMarkdown('````\ncode\n```\n还有内容\n\n后续');
      // 3 个反引号闭合不了 4 个反引号的 fence → 仍在 fence 内，空行不切块
      assert.deepEqual(split.blocks, []);
      assert.equal(split.openFence, '````\ncode\n```\n还有内容\n\n后续');
    },
  },
  {
    name: '最多 3 个前导空格的 fence 被识别',
    run: () => {
      const split = splitStreamingMarkdown('   ```js\ncode\n\nmore\n   ```\n\n尾');
      assert.deepEqual(split.blocks, ['   ```js\ncode\n\nmore\n   ```']);
      assert.equal(split.tail, '尾');
    },
  },
  {
    name: '4 个前导空格是缩进代码而非 fence（视作普通文本）',
    run: () => {
      const split = splitStreamingMarkdown('    ```js\n\n甲');
      // 不被当作 fence → 空行正常切块
      assert.deepEqual(split.blocks, ['    ```js']);
      assert.equal(split.tail, '甲');
      assert.equal(split.openFence, '');
    },
  },
  {
    name: '块尾部空白被裁掉（分隔空行不属于块）',
    run: () => {
      const split = splitStreamingMarkdown('甲   \n\n乙');
      assert.deepEqual(split.blocks, ['甲']);
    },
  },
];

// 增量不变量：把一篇真实形态的文档逐字符喂进去，模拟流式追加。
// 每步至多只有最后一个块允许变化 —— 否则「块级 memo 跳过解析」就不成立。
const document = [
  '# 标题',
  '',
  '第一段正文，包含 **加粗** 与 `行内代码`。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '```ts',
  'const a = 1;',
  '',
  'const b = 2;',
  '```',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```mermaid',
  'graph TD',
  'A-->B',
  '```',
  '',
  '收尾段落。',
  '',
].join('\n');

cases.push({
  name: '逐字符追加时，每步至多最后一个块变化（memo 前提）',
  run: () => {
    let previous: string[] = [];
    for (let end = 1; end <= document.length; end++) {
      const { blocks } = splitStreamingMarkdown(document.slice(0, end));
      // 除最后一块外，其余块必须与上一步逐字相同
      const stableCount = Math.max(0, blocks.length - 1);
      for (let i = 0; i < stableCount; i++) {
        assert.equal(
          blocks[i],
          previous[i],
          `第 ${end} 个字符处，块 #${i} 被改写：\n旧=${JSON.stringify(previous[i])}\n新=${JSON.stringify(blocks[i])}`,
        );
      }
      assert.ok(
        blocks.length >= Math.max(0, previous.length - 1),
        `第 ${end} 个字符处块数量回退：${previous.length} → ${blocks.length}`,
      );
      previous = blocks;
    }
    // 全文喂完后，最终定型块应当覆盖整篇（末尾空行已作为分隔符）
    assert.ok(previous.length >= 5, `最终块数偏少：${previous.length}`);
  },
});

cases.push({
  name: '未闭合 fence 期间不泄漏 Markdown：mermaid 只在 fence 完整后才进块',
  run: () => {
    const partial = document.slice(0, document.indexOf('A-->B') + 3);
    const split = splitStreamingMarkdown(partial);
    assert.equal(split.openFence.startsWith('```mermaid'), true);
    // mermaid 源码绝不能出现在已定型块里
    for (const block of split.blocks) {
      assert.equal(block.includes('A-->'), false, `块里混入了未完成的 mermaid：${block}`);
    }
  },
});

for (const item of cases) {
  item.run();
  console.log(`  [PASS] ${item.name}`);
}

console.log(`\nStreaming markdown tests: ${cases.length} PASS / 0 FAIL`);
