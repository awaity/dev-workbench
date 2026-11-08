import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

/**
 * 从唯一 SVG 源生成所有扩展图标，避免各尺寸的几何形状不一致。
 * @returns 所有 PNG 写入完成的 Promise。
 */
async function generateIcons() {
  const directory = resolve(import.meta.dirname, '../public/icons');
  const svg = await readFile(resolve(import.meta.dirname, '../public/favicon.svg'), 'utf8');
  await mkdir(directory, { recursive: true });
  for (const size of [16, 32, 48, 128, 256, 512]) {
    const renderer = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
    await writeFile(resolve(directory, `${size}.png`), renderer.render().asPng());
  }
}
await generateIcons();
