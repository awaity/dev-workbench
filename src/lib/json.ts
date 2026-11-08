import { JSONPath } from 'jsonpath-plus';

export const jsonExample = JSON.stringify(
  {
    project: '开发工作台',
    local: true,
    tools: [
      { name: 'JSON', category: '数据', favorite: true },
      { name: 'SM4', category: '加密', favorite: true },
      { name: 'HTTP', category: '开发', favorite: false },
    ],
    version: '1.0.0',
  },
  null,
  2,
);
/**
 * 解析严格 JSON，并将引擎语法异常转为可见的错误文本。
 * @param text - 待处理的原始文本。
 * @returns 解析后的 JSON 值。
 */
export function parseJson(text: string): unknown {
  if (!text.trim()) {
    throw new Error('请输入 JSON 内容，或点击「载入示例」');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 语法错误：${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}
/**
 * 使用 CSP 兼容解释器运行 JSONPath，不执行动态 JavaScript。
 * @param text - 待处理的原始文本。
 * @param path - 从根节点到目标节点的键名或数组索引。
 * @returns 包含匹配值、路径与 JSON Pointer 的结果列表。
 */
export function queryJson(text: string, path: string) {
  if (!path.trim().startsWith('$')) {
    throw new Error('JSONPath 必须以 $ 开始');
  }
  const json = parseJson(text);
  return JSONPath<{ path: string; value: unknown; pointer: string }[]>({
    path,
    json: json as object,
    resultType: 'all',
    eval: 'safe',
  });
}
/**
 * 按路径不可变替换 JSON 节点，拒绝路径中不存在的键。
 * @param root - 修改前的 JSON 根节点。
 * @param path - 从根节点到目标节点的键名或数组索引。
 * @param value - 待校验、转换或保存的值。
 * @returns 更新后的根节点，不修改输入对象。
 */
export function replaceNode(root: unknown, path: (string | number)[], value: unknown): unknown {
  if (!path.length) {
    return value;
  }
  const copy = structuredClone(root);
  let parent = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    if (!parent || !Object.hasOwn(parent, key)) {
      throw new Error('节点已不存在');
    }
    parent = parent[key] as Record<string | number, unknown>;
  }
  const last = path.at(-1)!;
  if (!parent || !Object.hasOwn(parent, last)) {
    throw new Error('节点已不存在');
  }
  Object.defineProperty(parent, last, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return copy;
}
/**
 * 删除对象字段或数组元素；根节点重置为 null。
 * @param root - 修改前的 JSON 根节点。
 * @param path - 从根节点到目标节点的键名或数组索引。
 * @returns 删除后的根节点；删除根节点时为 null。
 */
export function deleteNode(root: unknown, path: (string | number)[]): unknown {
  if (!path.length) {
    return null;
  }
  const copy = structuredClone(root);
  let parent = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    parent = parent[key] as Record<string | number, unknown>;
  }
  if (Array.isArray(parent)) {
    parent.splice(Number(path.at(-1)), 1);
  } else {
    delete parent[path.at(-1)!];
  }
  return copy;
}
