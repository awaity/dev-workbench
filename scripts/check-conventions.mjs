import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const failures = [];
let documented = 0;
/**
 * 遍历源码目录，收集需要执行规范检查的 TypeScript 与 Vue 文件。
 * @param directory - 待扫描的绝对目录。
 * @returns 源码文件路径列表。
 */
async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (/\.(ts|vue)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
}
for (const file of await sourceFiles(join(root, 'src'))) {
  const text = await readFile(file, 'utf8');
  const script = file.endsWith('.vue')
    ? text.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] || ''
    : text;
  if (
    file.endsWith('.vue') &&
    /<(?:button|input|textarea|select|option|details|summary)\b/.test(
      text.replace(/<script[^>]*>[\s\S]*?<\/script>/, ''),
    )
  ) {
    failures.push(`${file}: 交互控件应优先使用 Element Plus`);
  }
  const source = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true);
  /**
   * 检查命名函数的中文说明、参数与返回值文档，匿名回调不强制重复注释。
   * @param node - 当前 TypeScript 语法树节点。
   * @returns 无返回值，问题汇总到 failures。
   */
  function inspect(node) {
    let fn;
    let host;
    let name;
    if (ts.isFunctionDeclaration(node) && node.name) {
      fn = node;
      host = node;
      name = node.name.text;
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      ts.isIdentifier(node.name)
    ) {
      fn = node.initializer;
      host = node.parent.parent;
      name = node.name.text;
    }
    if (fn) {
      const doc = host.jsDoc?.at(-1)?.getText(source) || '';
      if (!/[\u4e00-\u9fff]/.test(doc) || !/@returns\s+\S/.test(doc)) {
        failures.push(`${file}: ${name} 缺少中文 JSDoc 或 @returns`);
      }
      for (const parameter of fn.parameters) {
        const key = parameter.name.getText(source);
        if (!new RegExp(`@param(?:\\s+\\{[^}]+\\})?\\s+${key}\\s+-\\s+\\S`).test(doc)) {
          failures.push(`${file}: ${name} 缺少参数 ${key} 的说明`);
        }
      }
      documented++;
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}
if (failures.length) {
  throw new Error(failures.join('\n'));
}
console.log(`组件规范通过，${documented} 个命名函数具备中文 JSDoc。`);
