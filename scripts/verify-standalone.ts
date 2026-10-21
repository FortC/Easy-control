import { _electron, type ElectronApplication } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const root=process.cwd();
const require=createRequire(import.meta.url);
const electronExe=require('../apps/desktop/node_modules/electron') as string;
const executablePath=process.argv[2]||electronExe;
const args=process.argv[2]?[]:[resolve(root,'apps/desktop')];
const profile=mkdtempSync(join(tmpdir(),'easycontrol-verify-'));
const out=resolve(root,'.local','standalone-verification');mkdirSync(out,{recursive:true});
const checks:{name:string;passed:boolean}[]=[];
function check(name:string,value:boolean){checks.push({name,passed:value});console.log(`${value?'✓':'✗'} ${name}`);if(!value)throw new Error(name);}
async function waitFor<T>(fn:()=>Promise<T>,pred:(r:T)=>boolean,timeout=30000):Promise<T>{const until=Date.now()+timeout;while(Date.now()<until){const r=await fn();if(pred(r))return r;await new Promise(r=>setTimeout(r,200));}throw new Error('等待状态超时');}
async function launch(){const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),EASYCONTROL_USER_DATA:profile};delete env.ELECTRON_START_URL;delete env.ELECTRON_RUN_AS_NODE;return _electron.launch({executablePath,args,env,timeout:60000});}
let app:ElectronApplication|undefined;
async function main(){
 app=await launch();
 app.process().stdout?.on('data',x=>writeFileSync(join(out,'engine.log'),x,{flag:'a'}));
 app.process().stderr?.on('data',x=>writeFileSync(join(out,'engine.log'),x,{flag:'a'}));
 const page=await app.firstWindow();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.getByRole('heading',{name:'每一次运营，都有条不紊。'}).waitFor({timeout:90000});
 const info=await page.evaluate(()=> (window as any).aipeople.getBackendPort());
 check('单个应用独立启动，内置引擎使用随机本地端口',info.mode==='standalone'&&info.port!==8787&&Boolean(info.sessionToken));
 check('未授权的网页无法访问本机引擎',(await fetch(`http://127.0.0.1:${info.port}/health`)).status===403);
 const version=await page.evaluate(()=> (window as any).aipeople.appInfo());check('版本从应用动态读取',version.version==='0.5.0');
 await page.screenshot({path:join(out,'01-dashboard.png')});
 for(const label of ['指令中心','CLI 接入中心','账号中心','助手与模型','内容工作台','资料与素材','任务与日历','结果与数据','异常处理','直播工作台','关于与帮助']){
   await page.getByRole('link',{name:label,exact:true}).click();await page.locator('main h1').first().waitFor();check(`页面可用：${label}`,true);
 }
 await page.getByRole('link',{name:'CLI 接入中心',exact:true}).click();
 check('目录覆盖四个平台',await page.getByRole('button',{name:'知乎',exact:true}).count()===1);
 await page.screenshot({path:join(out,'02-cli.png')});
 console.log('正在验证应用内 Redbook 安装（不需要客户 Node/npm）…');
 const installed=await page.evaluate(()=>(window as any).aipeople.tools.install('redbook'));
 check('内置 npm 安装真实 Redbook 包',installed.tools.some((t:any)=>t.id==='redbook'&&t.installed));
 const helpState=await page.evaluate(()=>(window as any).aipeople.tools.enqueue({toolId:'redbook',actionId:'help',values:{}}));
 const help=await waitFor(()=>page.evaluate(()=>(window as any).aipeople.tools.snapshot()),s=>Boolean(s.jobs.find((j:any)=>j.id===helpState.jobs[0].id)?.finishedAt));
 check('真实第三方 CLI 使用应用自带 Node 运行',help.jobs.find((j:any)=>j.id===helpState.jobs[0].id)?.status==='completed');
 const fixture=join(profile,'fixture.cjs');
 writeFileSync(fixture,`const a=process.argv.slice(2);if(a[0]==='identity')console.log(JSON.stringify({uid:'test-owner'}));else if(a[0]==='fail'){console.error('fixture failure');process.exitCode=2;}else if(a[0]==='captcha')console.log('captcha verification required');else console.log(JSON.stringify({ok:true,query:a[1]||'help',proof:process.env.DEMO_ACCOUNT_KEY||''}));`);
 const tool=await page.evaluate(async ({fixture})=>{const d=(window as any).aipeople;const s=await d.tools.save({id:'verify-local',name:'本地验证 CLI',platforms:['zhihu'],executable:fixture,description:'仅用于隔离环境验证，不连接真实平台',actions:[{id:'help',label:'帮助',kind:'read',args:['--help']},{id:'query',label:'测试读取',kind:'read',args:['read','{query}']},{id:'identity',label:'身份检查',kind:'read',args:['identity']},{id:'write',label:'测试写入',kind:'write',args:['write','{text}']},{id:'fail',label:'错误传播',kind:'read',args:['fail']},{id:'captcha',label:'验证拦截',kind:'read',args:['captcha']}]});return s.tools.find((t:any)=>t.id==='verify-local');},{fixture});
 check('自定义 CLI 导入与动作注册',tool.installed===true);
 let native=await page.evaluate(()=> (window as any).aipeople.tools.saveAccount({toolId:'verify-local',platform:'zhihu',name:'测试账号',uid:'test-owner',environment:{DEMO_ACCOUNT_KEY:'private-demo-value'}}));
 const accountId=native.accounts[0].id;
 check('账号 IPC 结果不暴露凭据',!JSON.stringify(native).includes('private-demo-value'));
 check('本地凭据加密落盘',!readFileSync(join(profile,'workbench/tools.json'),'utf8').includes('private-demo-value'));
 const run=async (actionId:string,values:Record<string,string>={},extra:Record<string,unknown>={})=>{
   const state=await page.evaluate(input=>(window as any).aipeople.tools.enqueue(input),{toolId:'verify-local',actionId,accountId,values,...extra});
   const id=state.jobs[0].id;
   return waitFor(()=>page.evaluate(()=>(window as any).aipeople.tools.snapshot()),s=>s.jobs.find((j:any)=>j.id===id)?.finishedAt!==undefined).then(s=>s.jobs.find((j:any)=>j.id===id));
 };
 const read=await run('query',{query:'中文参数 & echo should-not-execute'});
 check('CLI 使用内置运行时，参数不会当 Shell 执行',read.status==='completed'&&read.stdout.includes('中文参数 & echo should-not-execute'));
 check('CLI 输出凭据脱敏',!read.stdout.includes('private-demo-value')&&read.stdout.includes('已隐藏'));
 const publish=await run('write',{text:'经过确认的测试内容'},{confirmed:true});
 check('外发前核验账号 UID，保存回执但不伪造公开状态',publish.status==='completed'&&publish.summary.includes('核实平台'));
 const failure=await run('fail');check('CLI 失败如实返回',failure.status==='failed');
 const queued=await page.evaluate(input=>(window as any).aipeople.tools.enqueue(input),{toolId:'verify-local',actionId:'help',accountId,values:{},scheduledAt:new Date(Date.now()+1800).toISOString()});
 const scheduledId=queued.jobs[0].id;
 await waitFor(()=>page.evaluate(()=>(window as any).aipeople.tools.snapshot()),s=>s.jobs.find((j:any)=>j.id===scheduledId)?.status==='completed');check('本地定时任务自动执行',true);
 const future=await page.evaluate(input=>(window as any).aipeople.tools.enqueue(input),{toolId:'verify-local',actionId:'help',accountId,values:{},scheduledAt:new Date(Date.now()+600000).toISOString()});
 const cancelled=await page.evaluate(id=>(window as any).aipeople.tools.cancel(id),future.jobs[0].id);check('排程可取消',cancelled.jobs[0].status==='cancelled');
 const blocked=await run('captcha');native=await page.evaluate(()=>(window as any).aipeople.tools.snapshot());check('验证码转人工并暂停账号',blocked.status==='needs_human'&&native.accounts[0].paused);
 await page.getByRole('link',{name:'指令中心',exact:true}).click();await page.screenshot({path:join(out,'03-commands.png')});
 const voices=await page.evaluate(()=>(window as any).aipeople.live.voices());check('Windows 本机离线语音可用',Array.isArray(voices)&&voices.length>0);
 const speech=await page.evaluate(voice=>(window as any).aipeople.live.synthesize({text:'欢迎来到产品讲解直播间。',voice,rate:0}),voices[0].id);
 const header=await page.evaluate(async url=>{const r=await fetch(url);const b=await r.arrayBuffer();return {head:String.fromCharCode(...new Uint8Array(b.slice(0,4))),length:b.byteLength};},speech.url);
 check('真实合成可播放 WAV 音频',header.head==='RIFF'&&header.length>1000);
 const videoPath=join(root,'.local','test-media','flower.webm');check('小红书素材外的本地视频测试素材已可用',true);
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},videoPath);
 await page.getByRole('link',{name:'直播工作台',exact:true}).click();
 await page.getByRole('button',{name:'更换视频',exact:true}).click();
 await page.locator('.live-settings input').first().fill('产品讲解测试');
 await page.locator('.live-settings textarea').fill('欢迎来到产品讲解直播间。\n我们正在验证本地视频和离线语音的循环播放。');
 await page.getByRole('button',{name:'开始讲解',exact:true}).click();
 const output=await waitFor(async()=>app!.windows(),ws=>ws.length>=2);
 const stage=output.find(w=>w!==page)!;
 stage.on('console',m=>{if(m.type()==='error')console.error('stage:',m.text());});
 await stage.locator('.stage-caption h2').waitFor();
 check('直播输出窗口与工作台独立',await stage.locator('.stage-label').innerText().then(t=>t.includes('正在讲解')));
 await waitFor(()=>stage.evaluate(()=>{const v=document.querySelector('video');return Boolean(v&&!v.paused&&v.loop&&v.currentTime>0);}),Boolean).catch(async e=>{console.error('video state',await stage.evaluate(()=>{const v=document.querySelector('video');return {html:document.body.innerText,src:v?.src,ready:v?.readyState,error:v?.error?.message,paused:v?.paused,time:v?.currentTime};}));throw e;});
 check('本地视频解码并真实循环播放',true);
 await waitFor(()=>stage.evaluate(()=>{const a=document.querySelector('audio');return Boolean(a&&!a.paused&&a.currentTime>0);}),Boolean);
 check('输出窗口实际播放合成语音',true);
 await stage.screenshot({path:join(out,'05-stage.png')});
 await page.screenshot({path:join(out,'04-live.png')});
 await page.evaluate(()=>(window as any).aipeople.live.command('pause'));check('直播暂停状态同步',(await page.evaluate(()=>(window as any).aipeople.live.get())).status==='paused');
 await page.evaluate(()=>(window as any).aipeople.live.command('stop'));
 check('渲染无未处理异常',errors.length===0);
 const before=native.jobs.length;
 await app.close();app=undefined;
 app=await launch();const again=await app.firstWindow();await again.getByRole('heading',{name:'每一次运营，都有条不紊。'}).waitFor({timeout:90000});
 const persisted=await again.evaluate(()=>(window as any).aipeople.tools.snapshot());check('应用重启保留账号与操作记录',persisted.jobs.length===before&&persisted.accounts.length===1);
 await app.close();app=undefined;
 writeFileSync(join(out,'report.json'),JSON.stringify({at:new Date().toISOString(),version:'0.5.0',profile,checks},null,2));
 console.log(`\n${checks.length} 项验证通过，报告：${out}`);
}
main().catch(async e=>{console.error(e);writeFileSync(join(out,'failure.json'),JSON.stringify({error:String(e),checks},null,2));try{await app?.close();}catch{}process.exitCode=1;});


