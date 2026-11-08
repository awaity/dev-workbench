import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { PNG } from 'pngjs';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
const archive = join(root, `.output/dev-workbench-${manifest.version}-chrome.zip`);
const bytes = await readFile(archive);
const reader = new ZipReader(new Uint8ArrayReader(bytes));
/**
 * 收集发布目录相对路径，用于与 ZIP 的文件列表逐项对照。
 * @param directory - 待遍历的绝对目录。
 * @param prefix - 相对路径前缀。
 * @returns 目录中全部文件的相对路径。
 */
async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      result.push(...(await files(join(directory, entry.name), `${name}/`)));
    } else {
      result.push(name);
    }
  }
  return result.sort();
}
try {
  const entries = (await reader.getEntries()).filter((entry) => {
    return !entry.directory;
  });
  const names = entries
    .map((entry) => {
      return entry.filename;
    })
    .sort();
  for (const directory of ['dist', '.output/chrome-mv3']) {
    assert.deepEqual(names, await files(join(root, directory)));
  }
  for (const entry of entries) {
    const data = Buffer.from(await entry.getData(new Uint8ArrayWriter(), { checkSignature: true }));
    for (const directory of ['dist', '.output/chrome-mv3']) {
      assert.deepEqual(data, await readFile(join(root, directory, entry.filename)), entry.filename);
    }
  }
  for (const entry of [
    'index.html',
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ]) {
    assert(names.includes(entry), `缺少入口资源：${entry}`);
  }
  const iconSizes = [16, 32, 48, 128, 256, 512];
  for (const size of iconSizes) {
    const png = PNG.sync.read(await readFile(join(root, `dist/icons/${size}.png`)));
    assert.equal(png.width, size);
    assert.equal(png.height, size);
  }
  assert.equal(manifest.manifest_version, 3);
  assert.equal(
    manifest.version,
    JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
  );
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const report = {
    date: new Date().toISOString(),
    version: manifest.version,
    archive,
    bytes: bytes.length,
    files: names.length,
    iconSizes,
    crcChecked: true,
    matchesBuildAndDirectory: true,
  };
  await writeFile(join(root, 'artifacts/package-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await reader.close();
}
