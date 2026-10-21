import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root=process.cwd();
async function run(label:string,args:string[],cwd=root){
 console.log(`\n▶ ${label}`);
 await new Promise<void>((ok,fail)=>{const child=spawn(process.execPath,args,{cwd,stdio:'inherit',shell:false,windowsHide:true});child.on('error',fail);child.on('exit',code=>code===0?ok():fail(new Error(`${label}失败（${code}）`)));});
}
async function main(){
 await run('类型检查',['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json']);
 await run('业务规则测试',['node_modules/vitest/vitest.mjs','run']);
 await run('开源图标资源',['node_modules/tsx/dist/cli.mjs','scripts/render-icons.ts']);
 await run('同步应用内运行环境',['node_modules/tsx/dist/cli.mjs','scripts/sync-desktop-runtime.ts']);
 await run('构建界面',[resolve(root,'apps/desktop/node_modules/vite/bin/vite.js'),'build'],resolve(root,'apps/desktop'));
 const desktopDir=resolve(root,'apps/desktop');
 const electronVersion=(JSON.parse(readFileSync(resolve(desktopDir,'package.json'),'utf8')) as {devDependencies:Record<string,string>}).devDependencies.electron;
 const electronCache=process.env.LOCALAPPDATA?resolve(process.env.LOCALAPPDATA,'electron/Cache'):'';
 const cachedElectron=electronCache&&existsSync(electronCache)?readdirSync(electronCache).find(folder=>existsSync(resolve(electronCache,folder,`electron-v${electronVersion}-win32-x64.zip`))):undefined;
 const builderArgs=['--win','nsis','--publish','never','--config','electron-builder.yml'];
 if(cachedElectron){builderArgs.push('--config.electronDist',resolve(electronCache,cachedElectron));console.log('使用 pnpm 已缓存的 Electron Windows 运行时。');}
 await run('打包 Windows 安装程序',[resolve(desktopDir,'node_modules/electron-builder/cli.js'),...builderArgs],desktopDir);
 const exe=resolve(root,'apps/desktop/release/win-unpacked/EasyControl.exe');
 if(!existsSync(exe))throw new Error('安装包应用文件缺失');
 await run('独立应用端到端验证',['node_modules/tsx/dist/cli.mjs','scripts/verify-standalone.ts',exe]);
 console.log('\nWindows 安装程序已生成，目录：apps/desktop/release（无 Docker 或外部服务要求）');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
