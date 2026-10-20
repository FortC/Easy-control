import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // 打包后走 file:// 协议加载，必须用相对路径（默认 "/" 会解析到文件系统根导致白屏）
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist-renderer",
  },
});
