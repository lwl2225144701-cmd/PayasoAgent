// 验证评分器能拒绝原始缺陷、越界修改和多轮内容回退，不调用 LLM。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluate, type BaselineCase } from './baseline/evaluate.js';
const cases: BaselineCase[] = JSON.parse(fs.readFileSync(new URL('./baseline/cases.json', import.meta.url), 'utf8'));
for (const id of ['C1', 'C2', 'C3', 'M3']) {
  const test = cases.find(test => test.id === id)!;
  assert.ok(evaluate(test, test.files, '').length > 0, `${id} must reject original bug`);
}
const fixed: Record<string, Record<string, string>> = {
  C1: { 'sort.cjs': 'exports.sortNumbers = x => [...x].sort((a,b) => a-b);' },
  C2: { 'config.cjs': 'exports.resolveConfig = o => ({retries:o.retries ?? 3, timeout:o.timeout ?? 1000});' },
  C3: { 'unique.cjs': 'exports.uniqueById = rows => { const ids = new Set(); return rows.filter(r => {if(ids.has(r.id)) return false; ids.add(r.id); return true;}); };' },
  M1: { 'config.json': '{"timeout":30,"retries":2,"format":"JSON","owner":"林舟","compression":true}' },
  M3: { 'math.cjs': 'exports.sum=(a,b)=>a+b; exports.label="stable-api"; exports.mean=x=>x.length?x.reduce((a,b)=>a+b,0)/x.length:null;' },
};
for (const [id, files] of Object.entries(fixed)) {
  const test = cases.find(test => test.id === id)!;
  assert.deepEqual(evaluate(test, { ...test.files, ...files }, ''), [], id);
  assert.ok(evaluate(test, { ...test.files, ...files, 'unexpected.txt': 'changed' }, '').some(failure => failure.includes('越界')));
}
const summary = cases.find(test => test.id === 'S1')!;
assert.ok(evaluate(summary, summary.files, '已完成').length > 0);
const multi = cases.find(test => test.id === 'M2')!;
assert.ok(evaluate(multi, { ...multi.files, 'report.md': 'changed' }, '', { 'report.md': 'original' }).some(failure => failure.includes('改写')));
console.log('Baseline evaluator: PASS');
