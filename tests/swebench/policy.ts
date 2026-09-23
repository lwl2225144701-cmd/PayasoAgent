// 测试污染检测（方案 §5.3 policy v1 / A2）：只检查**提交的 diff 触及的路径**——
// diff 是最终提交物，对它的检测可靠；trace 里的测试执行只记录、不作判定依据。
// 纯函数，可单测（policy.test.ts）。
import path from 'node:path';

const TEST_FILE_RE = /(^|\/)(test_[^/]+\.py|[^/]+_test\.py)$/;
const TEST_DIR_RE = /(^|\/)(tests?|testing)\//;
const TEST_HOOK_FILES = new Set(['conftest.py', 'pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml']);

export interface PolicyVerdict {
  policyInvalid: boolean;
  /** 命中规则的路径（含来源：pattern / test_patch）。 */
  hits: Array<{ file: string; rule: string }>;
}

/** 单条路径是否命中已知测试污染模式。命中返回规则名，否则 null。 */
export function matchTestPath(filePath: string): string | null {
  const normalized = filePath.replaceAll('\\', '/');
  if (TEST_FILE_RE.test(normalized)) return 'test_file';
  if (TEST_DIR_RE.test(normalized)) return 'test_dir';
  const base = path.posix.basename(normalized);
  if (TEST_HOOK_FILES.has(base)) {
    // pyproject.toml / setup.cfg 仅在其真的含测试配置时才应命中——粗粒度命中可接受：
    // 误伤记 policy_invalid + 人工复核（宁可漏分，方案 §7.6）。
    return 'test_hook';
  }
  return null;
}

/**
 * 判定 diff 是否污染测试：
 * ① 已知模式（TEST_FILE / TEST_DIR / TEST_HOOK）
 * ② test_patch 实际触及的路径（数据集推导——gold 测试补丁改的文件，agent 也不该动）
 */
export function detectTestPollution(
  changedPaths: readonly string[],
  testPatchPaths: readonly string[] = [],
): PolicyVerdict {
  const hits: PolicyVerdict['hits'] = [];
  const testPatchSet = new Set(testPatchPaths.map((p) => p.replaceAll('\\', '/')));
  for (const file of changedPaths) {
    const rule = matchTestPath(file);
    if (rule) {
      hits.push({ file, rule });
      continue;
    }
    if (testPatchSet.has(file.replaceAll('\\', '/'))) {
      hits.push({ file, rule: 'test_patch' });
    }
  }
  return { policyInvalid: hits.length > 0, hits };
}

/** 从 git diff --name-only 输出解析路径列表（空行/引号包裹的路径均处理）。 */
export function parseChangedPaths(nameOnlyOutput: string): string[] {
  return nameOnlyOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
