export type CliAction = { id:string; label:string; args:string[]; kind:'read'|'write' };
export type CliTool = { id:string; name:string; description:string; platforms:string[]; source:string; repository:string; license:string; stars?:number; checkedAt?:string; package?:string; executable:string; installed:boolean; installedVersion?:string; actions:CliAction[] };
export type CliAccount = {id:string; toolId:string; platform:string; name:string; uid:string; paused:boolean; hasCredentials:boolean};
export type CliJob = {id:string; toolId:string; accountId:string|null; platform:string; actionId:string; actionLabel:string; accountName:string; kind:string; args:string[]; prompt:string; status:string; summary:string; scheduledAt:string; createdAt:string; finishedAt?:string; stdout:string; stderr:string};
export type ToolsState = {tools:CliTool[]; accounts:CliAccount[]; jobs:CliJob[]; running:boolean};
export type Scene = {title:string; script:string; videoPath:string; videoUrl:string; voice:string; rate:number; loop:boolean; muted:boolean; orientation:string; status:'running'|'paused'|'stopped'};
export type Voice = {id:string; name:string; culture:string};
type DesktopBridge = {
  appInfo():Promise<{version:string;name:string;dataPath:string;platform:string}>;
  openData():Promise<unknown>; openExternal(url:string):Promise<unknown>; copyText(text:string):Promise<boolean>;
  tools:{snapshot():Promise<ToolsState>; install(id:string):Promise<ToolsState>; save(input:unknown):Promise<ToolsState>; remove(id:string):Promise<ToolsState>; choose():Promise<string|null>; chooseImage():Promise<string|null>; enqueue(input:unknown):Promise<ToolsState>; cancel(id:string):Promise<ToolsState>; export():Promise<boolean>; saveAccount(input:unknown):Promise<ToolsState>; removeAccount(id:string):Promise<ToolsState>; pauseAccount(id:string):Promise<ToolsState>};
  live:{get():Promise<Scene>;save(input:Partial<Scene>):Promise<Scene>;chooseVideo():Promise<Scene>;voices():Promise<Voice[]>;synthesize(input:{text:string;voice?:string;rate?:number}):Promise<{url:string}>;open():Promise<void>;command(action:string):Promise<Scene>;onState(fn:(scene:Scene)=>void):()=>void};
};
export const desktop=(window as unknown as {aipeople:DesktopBridge}).aipeople;
export const JOB_LABELS:Record<string,string>={scheduled:'已排程',running:'执行中',completed:'已完成',failed:'失败',unknown:'待核实',needs_human:'需人工',cancelled:'已取消',missed:'错过时间'};
export const PLATFORM_NAMES:Record<string,string>={weibo:'微博',zhihu:'知乎',douyin:'抖音',xiaohongshu:'小红书'};
