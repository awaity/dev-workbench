import { createRequire } from 'node:module';
import { readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packages = new Map();
/**
 * 查找依赖的实际安装目录，兼容 package exports 禁止读取 package.json。
 * @param name - 要解析的依赖包名称。
 * @param from - 用于解析依赖的起始目录。
 * @returns 依赖包实际安装目录的绝对路径。
 */
function packageRoot(name, from) {
  const require = createRequire(join(from, 'package.json'));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    let folder = dirname(require.resolve(name));
    while (!existsSync(join(folder, 'package.json'))) {
      const parent = dirname(folder);
      if (parent === folder) {
        throw new Error(`无法定位 ${name} 的许可信息`);
      }
      folder = parent;
    }
    return folder;
  }
}
/**
 * 收集实际打包的生产依赖及其传递依赖许可文本。
 * @param name - 要解析的依赖包名称。
 * @param from - 用于解析依赖的起始目录。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function visit(name, from) {
  const folder = await realpath(packageRoot(name, from));
  if (packages.has(folder)) {
    return;
  }
  const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
  const names = (await readdir(folder)).filter((file) => {
    return /^(licen[sc]e|copying)(\.|$)/i.test(file);
  });
  const licenses = await Promise.all(
    names.map((file) => {
      return readFile(join(folder, file), 'utf8');
    }),
  );
  packages.set(folder, {
    name: `${pkg.name}@${pkg.version}`,
    text: `${pkg.name}@${pkg.version}\nLicense: ${pkg.license || 'See upstream license'}\n${licenses.join('\n')}`,
  });
  for (const dependency of Object.keys(pkg.dependencies || {})) {
    await visit(dependency, folder);
  }
}
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const name of Object.keys(pkg.dependencies)) {
  await visit(name, root);
}
const text = [...packages.values()]
  .sort((a, b) => {
    return a.name.localeCompare(b.name);
  })
  .map((entry) => {
    return entry.text;
  })
  .join('\n\n------------------------------\n\n');
await writeFile(join(root, 'public/THIRD_PARTY_LICENSES.txt'), text);
console.log(`已收集 ${packages.size} 个生产依赖的许可信息。`);
