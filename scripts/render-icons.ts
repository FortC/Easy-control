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
  const svg = readFileSync(resolve(srcDir, svgFile), "utf8");
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

console.log("渲染图标（Lucide bot，ISC License）:");
render("bot-brand.svg", "icon.png", 256); // electron-builder 自动转 ico
render("bot-brand.svg", "icon-512.png", 512); // 安装程序/商店展示
render("bot-white.svg", "tray.png", 64); // 托盘（运行时 resize 16/32）
render("bot-brand.svg", "../public/icon.png", 64); // 渲染层 favicon
console.log("完成。");
