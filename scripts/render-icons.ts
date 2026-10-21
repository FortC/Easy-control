/**
 * 图标资源生成：把 Iconify API 下载的 Lucide 现成图标（ISC 许可，免费商用）
 * 渲染为 Electron 需要的 PNG 位图（窗口图标 / 托盘 / favicon）。
 * 运行：pnpm icons（SVG 源已在 assets/icons/ 下）
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = resolve(root, "assets/icons");
const outDir = resolve(root, "apps/desktop/resources");
const publicDir = resolve(root, "apps/desktop/public");

function render(svgFile: string, outFile: string, size: number): void {
  const svg = readFileSync(resolve(srcDir, svgFile), "utf8").replaceAll('currentColor', outFile === 'tray.png' ? '#ffffff' : '#3567e9');
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
  });
  const png = resvg.render().asPng();
  const target = resolve(outDir, outFile);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, png);
  console.log(`  ${svgFile} → ${outFile} (${size}px, ${png.length} bytes)`);
}

mkdirSync(outDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

console.log("渲染现成图标（Lucide panels-top-left，ISC License）:");
render("panels-top-left.svg", "icon.png", 256);
render("panels-top-left.svg", "icon-512.png", 512);
render("panels-top-left.svg", "tray.png", 64);
render("panels-top-left.svg", "../public/icon.png", 64);
console.log("完成。");
