const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const PLATFORMS = ['weibo', 'zhihu', 'douyin', 'xiaohongshu'];
const CATALOG = [
  { id: 'opencli', name: 'OpenCLI', source: 'community', platforms: PLATFORMS, repository: 'https://github.com/jackwener/OpenCLI', license: 'Apache-2.0', stars: 30499, checkedAt: '2026-10-21', package: '@jackwener/opencli@2.0.2', bin: 'opencli', description: '多平台开源 CLI；部分能力需要按上游说明连接自己的浏览器。', actions: [
    { id: 'help', label: '使用帮助', args: ['--help'], kind: 'read' },
    { id: 'catalog', label: '发现可用命令', args: ['list'], kind: 'read' },
    { id: 'zhihu-hot', label: '知乎热榜', args: ['zhihu', 'hot'], kind: 'read' },
  ] },
  { id: 'redbook', name: 'Redbook（一期仅查看上游信息）', source: 'community', platforms: ['xiaohongshu'], repository: 'https://github.com/lucasygu/redbook', license: 'MIT', stars: 524, checkedAt: '2026-10-21', package: '@lucasygu/redbook@0.8.2', bin: 'redbook', description: '第一版不启用小红书账号授权或平台命令；仅保留 CLI 版本与许可信息。小红书内容生成、审核后复制/导出，由真人登录并交付。', actions: [
    { id: 'help', label: '使用帮助', args: ['--help'], kind: 'read' },
  ] },
  { id: 'weibo', name: '微博官方 CLI', source: 'official', platforms: ['weibo'], repository: 'https://open.weibo.com/cli/quickstart', license: '官方服务条款', package: '@weibo-ai/weibo-cli@0.9.8', bin: 'weibo-cli', description: '官方认证与 OAuth 接入；开源工具安装不代表平台调用免费。', actions: [
    { id: 'help', label: '使用帮助', args: ['--help'], kind: 'read' },
    { id: 'login', label: '账号授权 · 设备码登录', args: ['auth','login','--device'], kind: 'read' },
    { id: 'identity', label: '检查账号与服务', args: ['me', '--output', 'json'], kind: 'read' },
    { id: 'doctor', label: '连接诊断', args: ['doctor'], kind: 'read' },
    { id: 'catalog', label: '发现已授权命令', args: ['commands', 'list', '--available'], kind: 'read' },
  ] },
];

function createToolService({ app, safeStorage, notify }) {
  const root = path.join(app.getPath('userData'), 'workbench');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'tools.json');
  let state = { tools: [], accounts: [], jobs: [] };
  if (fs.existsSync(file)) state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  for (const tool of state.tools) if (tool.platforms?.includes('xiaohongshu')) tool.actions = (tool.actions || []).filter(a => a.id === 'help' && a.kind === 'read' && JSON.stringify(a.args) === '["--help"]');
  for (const account of state.accounts) if (account.platform === 'xiaohongshu') { account.secret = undefined; account.paused = true; account.revision = randomUUID(); }
  for (const job of state.jobs) if (job.platform === 'xiaohongshu' && job.kind === 'write') { if (job.status === 'scheduled') job.status = 'cancelled'; if (job.status === 'running') job.status = 'unknown'; job.summary = '第一版小红书只支持内容助手与人工交付；此任务已停止，请由真人处理。'; }
  for (const job of state.jobs) if (job.status === 'running') { job.status = 'unknown'; job.summary = '上次执行中应用退出；请核对结果后再操作。'; }
  let active = false;
  let closed = false;
  let runningChild = null;
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(file + '.tmp', file); };
  save();
  const secretKeys = () => state.accounts.flatMap(a => {
    try { return Object.values(JSON.parse(safeStorage.decryptString(Buffer.from(a.secret || '', 'base64')))); } catch { return []; }
  }).filter(x => typeof x === 'string' && x.length > 3);
  const redact = (value) => {
    let text = String(value || '');
    for (const secret of secretKeys()) text = text.split(secret).join('[已隐藏]');
    return text.replace(/(Bearer\s+)[\w.\-]+/gi, '$1[已隐藏]').replace(/("?(?:api[_-]?key|token|cookie|web_session|secret|password)"?\s*[=:]\s*["']?)[^\s,"';}]+/gi, '$1[已隐藏]');
  };
  const listTools = () => [...CATALOG, ...state.tools.filter(t => !CATALOG.some(c => c.id === t.id))].map(base => {
    const t = { ...base, ...state.tools.find(t => t.id === base.id) };
    return { ...t, installed: Boolean(t.executable && fs.existsSync(t.executable)), executable: t.executable || '', actions: t.actions || [] };
  });
  const publicAccount = ({ secret, ...account }) => ({ ...account, hasCredentials: Boolean(secret) });
  const snapshot = () => ({ tools: listTools(), accounts: state.accounts.map(publicAccount), jobs: state.jobs.slice(0, 200), running: active });
  function validateTool(input) {
    if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('填写工具名称');
    if (!PLATFORMS.includes(input.platforms?.[0])) throw new Error('选择支持的平台');
    if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 30) throw new Error('需要 1–30 个动作模板');
    const ids = new Set();
    for (const a of input.actions) {
      if (!/^[\w-]{1,60}$/.test(a.id) || ids.has(a.id)) throw new Error('动作 ID 需唯一且只含字母、数字和横线');
      ids.add(a.id);
      if (!['read','write'].includes(a.kind) || !Array.isArray(a.args) || a.args.length > 50 || a.args.some(x => typeof x !== 'string' || x.length > 10000)) throw new Error('动作参数必须是字符串数组，并声明 read 或 write');
      if (!a.label) throw new Error('填写动作名称');
      if (input.platforms.includes('xiaohongshu') && a.kind === 'write') throw new Error('第一版仅支持小红书内容助手与真人交付，不开放小红书自动发布、评论、私信或群聊');
      if(a.args.some(x=>/\{(?:token|cookie|password|secret|apiKey)\}/i.test(x)))throw new Error('敏感凭据请使用账号的加密环境变量，不要放进命令参数');
    }
    if (input.executable && (!path.isAbsolute(input.executable) || !fs.existsSync(input.executable) || !/\.(exe|js|cjs|mjs)$/i.test(input.executable))) throw new Error('选择已存在的 EXE 或 JavaScript CLI 入口');
  }
  function upsertTool(input) {
    validateTool(input);
    const id = input.id || `tool_${randomUUID()}`;
    const old = listTools().find(t => t.id === id);
    const tool = { ...old, id, name: input.name.trim().slice(0,100), platforms: input.platforms.filter(p => PLATFORMS.includes(p)), executable: input.executable || old?.executable || '', actions: input.actions, description: String(input.description || '').slice(0,1000), source: old?.source || 'custom', repository: old?.repository || '', license: old?.license || '用户提供' };
    state.tools = [...state.tools.filter(t => t.id !== id), tool]; save(); return snapshot();
  }
  function runProcess(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd || root, env: { ...process.env, ...options.env }, shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      runningChild = child;
      let stdout = '', stderr = '', timedOut = false, overflow = false;
      const limit = 512 * 1024;
      const collect = (key, chunk) => {
        if (key === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
        if(options.onOutput) options.onOutput(redact(stdout.slice(-limit)),redact(stderr.slice(-limit)));
        if (stdout.length + stderr.length > limit) { overflow = true; child.kill(); }
      };
      child.stdout.on('data', c => collect('stdout', c)); child.stderr.on('data', c => collect('stderr', c));
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs || 90000);
      child.on('error', e => { clearTimeout(timer); reject(new Error(redact(e.message))); });
      child.on('close', code => { clearTimeout(timer); runningChild = null; resolve({ code, stdout: redact(stdout.slice(-limit)), stderr: redact(stderr.slice(-limit)), timedOut, overflow }); });
      if (options.input) child.stdin.end(options.input); else child.stdin.end();
    });
  }
  async function install(id) {
    if (active) throw new Error('请等待当前任务完成后安装工具');
    const item = CATALOG.find(t => t.id === id);
    if (!item) throw new Error('只允许从内置目录安装；其他工具请导入本地入口');
    active = true;
    try {
      const dest = path.join(root, 'tools', id);
      fs.mkdirSync(dest, { recursive: true });
      const npmEntry = app.isPackaged ? path.join(process.resourcesPath, 'tool-runtime', 'npm', 'bin', 'npm-cli.js') : path.join(__dirname, '../resources/tool-runtime/npm/bin/npm-cli.js');
      if (!fs.existsSync(npmEntry)) throw new Error('应用的 npm 运行环境缺失，请重新安装完整安装包');
      const result = await runProcess(process.execPath, [npmEntry, 'install', '--prefix', dest, '--ignore-scripts', '--no-audit', '--no-fund', item.package], { env: { ELECTRON_RUN_AS_NODE: '1' }, timeoutMs: 300000 });
      if (result.code !== 0) throw new Error(`安装失败：${result.stderr.slice(-1200) || result.stdout.slice(-1200)}`);
      const name = item.package.slice(0, item.package.lastIndexOf('@'));
      const manifestPath = path.join(dest, 'node_modules', name, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const relative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[item.bin];
      if (!relative) throw new Error('包没有预期的 CLI 入口');
      const executable = path.resolve(path.dirname(manifestPath), relative);
      if (!executable.startsWith(path.resolve(dest) + path.sep) || !fs.existsSync(executable)) throw new Error('CLI 入口超出工具目录或不存在');
      state.tools = [...state.tools.filter(t => t.id !== id), { ...item, executable, installedVersion: pkg.version }]; save(); return snapshot();
    } finally { active = false; }
  }
  function saveAccount(input) {
    const tool = listTools().find(t => t.id === input.toolId);
    if (!tool || !tool.platforms.includes(input.platform) || !input.name?.trim()) throw new Error('选择工具、平台并填写账号名称');
    let environment = input.environment || {};
    if (typeof environment !== 'object' || Array.isArray(environment)) throw new Error('凭据环境变量必须是 JSON 对象');
    if (input.platform === 'xiaohongshu') throw new Error('第一版小红书不连接 CLI 账号或平台会话，请在人工交付工作区管理已审核内容。');
    for (const [k,v] of Object.entries(environment)) {
      if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(k) || ['PATH','HOME','USERPROFILE','NODE_OPTIONS','ELECTRON_RUN_AS_NODE','COMSPEC'].includes(k) || typeof v !== 'string') throw new Error('环境变量键不合法或覆盖系统执行环境');
    }
    const id = input.id || `account_${randomUUID()}`;
    const old = state.accounts.find(a => a.id === id);
    let secret = old?.secret;
    if (Object.keys(environment).length) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用，未保存敏感信息');
      secret = safeStorage.encryptString(JSON.stringify(environment)).toString('base64');
    }
    const account = { id, toolId: input.toolId, platform: input.platform, name: input.name.trim().slice(0,80), uid: String(input.uid || '').slice(0,100), secret, paused: false, revision:randomUUID(), createdAt: old?.createdAt || new Date().toISOString() };
    state.accounts = [...state.accounts.filter(a => a.id !== id), account]; save(); return snapshot();
  }
  function buildJob(input) {
    const tool = listTools().find(t => t.id === input.toolId);
    if (!tool?.installed) throw new Error('请先安装或导入 CLI 工具');
    const action = tool.actions.find(a => a.id === input.actionId);
    if (!action) throw new Error('动作模板不存在');
    const account = input.accountId ? state.accounts.find(a => a.id === input.accountId && a.toolId === tool.id) : null;
    if (input.accountId && !account) throw new Error('账号不属于所选工具');
    if ((account?.platform || tool.platforms[0]) === 'xiaohongshu' && !(action.id === 'help' && JSON.stringify(action.args) === '["--help"]' && action.kind === 'read')) throw new Error('第一版小红书仅支持内容助手与真人交付，不允许 CLI 读取登录态或操作平台');
    if (tool.platforms.includes('xiaohongshu') && action.kind === 'write') throw new Error('第一版小红书仅支持内容助手与真人交付，不开放自动发布或互动动作');
    if (action.kind === 'write' && input.confirmed !== true) throw new Error('外发动作需要确认具体目标与内容');
    if (account?.paused) throw new Error('账号已暂停');
    if(action.kind==='write' && (!account?.uid || !tool.actions.some(a=>a.id==='identity')))throw new Error('外发需要选择已登记 UID 的账号，并为工具配置 identity 身份检查动作');
    const values = input.values || {};
    const args = action.args.map(arg => arg.replace(/\{(\w+)\}/g, (_, key) => {
      const value = values[key];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写参数 ${key}`);
      if (value.length > 20000) throw new Error('参数过长');
      return value;
    }));
    const at = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
    if (Number.isNaN(at.getTime())) throw new Error('排程时间无效');
    if (at.getTime() < Date.now() - 60000) throw new Error('排程时间已过期');
    return { id: `job_${randomUUID()}`, toolId: tool.id, accountId: account?.id || null, accountRevision:account?.revision, templateHash:fingerprint([tool.executable,action.args,action.kind]), accountName: account?.name || '工具默认会话', platform: account?.platform || tool.platforms[0], actionId: action.id, actionLabel: action.label, kind: action.kind, args, executable: tool.executable, prompt: String(input.prompt || '').slice(0,5000), createdAt: new Date().toISOString(), scheduledAt: at.toISOString(), status: 'scheduled', summary: '等待执行', stdout: '', stderr: '' };
  }
  function enqueue(input) { const job = buildJob(input); state.jobs.unshift(job); state.jobs = state.jobs.slice(0,500); save(); void tick(); return snapshot(); }
  function cancel(id) { const job = state.jobs.find(j => j.id === id); if (!job || job.status !== 'scheduled') throw new Error('只有未开始的任务可取消'); job.status = 'cancelled'; job.summary = '用户取消'; save(); return snapshot(); }
  async function tick() {
    if (active || closed) return;
    const job = state.jobs.find(j => j.status === 'scheduled' && Date.parse(j.scheduledAt) <= Date.now());
    if (!job) return;
    if (Date.now() - Date.parse(job.scheduledAt) > 30 * 60000) { job.status = 'missed'; job.summary = '错过执行窗口，请重新排程'; save(); return; }
    active = true;
    try {
      const tool = listTools().find(t => t.id === job.toolId);
      const account = job.accountId ? state.accounts.find(a => a.id === job.accountId && !a.paused) : null;
      const currentAction=tool?.actions.find(a=>a.id===job.actionId);
      if (!tool?.installed || tool.executable !== job.executable || !currentAction || fingerprint([tool.executable,currentAction.args,currentAction.kind])!==job.templateHash || (job.accountId && (!account || account.revision!==job.accountRevision))) throw new Error('工具配置或账号已变化，请重新确认任务');
      const environment = account?.secret ? JSON.parse(safeStorage.decryptString(Buffer.from(account.secret, 'base64'))) : {};
      job.status = 'running'; job.startedAt = new Date().toISOString(); save();
      const js = /\.(?:cjs|mjs|js)$/i.test(tool.executable);
      const env={...environment,...(js?{ELECTRON_RUN_AS_NODE:'1'}:{})};
      if(job.kind==='write'){
        const identity=tool.actions.find(a=>a.id==='identity'&&a.kind==='read');
        if(!identity || identity.args.some(a=>/\{\w+\}/.test(a)))throw new Error('身份检查动作必须是固定的只读命令');
        const check=await runProcess(js?process.execPath:tool.executable,js?[tool.executable,...identity.args]:identity.args,{env});
        let info;try{const text=check.stdout;info=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));}catch{throw new Error('无法解析账号身份，未执行外发');}
        const identities=[info,info?.data,info?.user,info?.data?.user].filter(Boolean).flatMap(x=>[x.uid,x.user_id,x.idstr,x.id]).filter(x=>x!==undefined).map(String);
        if(check.code!==0 || !identities.includes(account.uid))throw new Error('CLI 当前会话与登记 UID 不一致或无法核实，未执行外发');
      }
      job.submissionStarted=job.kind==='write';save();
      const result = await runProcess(js ? process.execPath : tool.executable, js ? [tool.executable, ...job.args] : job.args, { env, timeoutMs:job.actionId==='login'?180000:90000, onOutput:(stdout,stderr)=>{job.stdout=stdout;job.stderr=stderr;} });
      job.stdout = result.stdout; job.stderr = result.stderr; job.exitCode = result.code;
      const blocked = /captcha|验证码|needs.verify|会话过期|session.expired|登录失效|300012/i.test(result.stderr + result.stdout);
      job.status = blocked ? 'needs_human' : result.timedOut || result.overflow ? (job.kind === 'write' ? 'unknown' : 'failed') : result.code === 0 ? 'completed' : 'failed';
      job.summary = blocked ? '平台要求验证或会话处理，请人工检查' : result.timedOut ? '执行超时；写入结果需人工核实' : result.overflow ? '输出过大，执行已停止' : result.code === 0 ? (job.kind === 'write' ? 'CLI 已返回成功，请核实平台审核和公开状态' : '读取完成，结果已保存') : `CLI 执行失败（${result.code}），请查看详情`;
      if (blocked && account) account.paused = true;
    } catch (e) { job.status = job.submissionStarted ? 'unknown' : 'failed'; job.summary = redact(e.message); }
    finally { job.finishedAt = new Date().toISOString(); active = false; save(); notify(job); }
  }
  const timer = setInterval(() => void tick(), 1000);
  return {
    snapshot, install, upsertTool, saveAccount, enqueue, cancel,
    removeTool(id) { if (state.jobs.some(j => j.toolId === id && j.status === 'running')) throw new Error('工具正在执行'); state.tools = state.tools.filter(t => t.id !== id); save(); return snapshot(); },
    removeAccount(id) { state.accounts = state.accounts.filter(a => a.id !== id); for (const j of state.jobs) if (j.accountId === id && j.status === 'scheduled') j.status = 'cancelled'; save(); return snapshot(); },
    pauseAccount(id) { const a = state.accounts.find(a => a.id === id); if (a) a.paused = !a.paused; save(); return snapshot(); },
    stop() { closed = true; clearInterval(timer); runningChild?.kill(); save(); },
  };
}
module.exports = { createToolService, CATALOG };

