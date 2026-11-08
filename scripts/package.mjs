import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

const root = resolve(import.meta.dirname, '..');
const output = join(root, '.output');
const extension = join(output, 'chrome-mv3');
const manifest = JSON.parse(await readFile(join(root, 'dist', 'manifest.json'), 'utf8'));
const archive = join(output, `dev-workbench-${manifest.version}-chrome.zip`);

await mkdir(output, { recursive: true });
await rm(extension, { recursive: true, force: true });
await cp(join(root, 'dist'), extension, { recursive: true });

const writer = new ZipWriter(new Uint8ArrayWriter());
/**
 * 递归写入构建文件，ZIP 路径以扩展目录为根并统一使用正斜杠。
 * @param {string} directory - 待遍历的扩展目录或其子目录。
 * @returns {Promise<void>} 文件全部写入后的 Promise；读取或压缩失败时拒绝。
 */
async function addFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => {
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await addFiles(path);
    } else if (entry.isFile()) {
      const name = relative(extension, path).split(sep).join('/');
      await writer.add(name, new Uint8ArrayReader(await readFile(path)));
    }
  }
}
await addFiles(extension);
await writeFile(archive, await writer.close());
console.log(`Extension: ${extension}\nArchive: ${archive}`);
