const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');

function createLiveStudio({ app, dialog, broadcast }) {
  const root = path.join(app.getPath('userData'), 'live'); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'scene.json');
  let scene = { title: '新品讲解直播间', script: '', videoPath: '', voice: '', rate: 0, loop: true, muted: true, orientation: 'landscape', status: 'stopped' };
  if (fs.existsSync(file)) scene = { ...scene, ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'stopped' };
  const media = new Map();
  let synthQueue = Promise.resolve();
  const audioDir = path.join(root, 'audio'); fs.mkdirSync(audioDir, { recursive: true });
  function mediaUrl(filePath) { const id = createHash('sha256').update(filePath).digest('hex'); media.set(id, filePath); return `easy-media://media/${id}`; }
  const snapshot = () => ({ ...scene, videoUrl: scene.videoPath && fs.existsSync(scene.videoPath) ? mediaUrl(scene.videoPath) : '' });
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(scene)); fs.renameSync(file + '.tmp', file); };
  function update(input) {
    for (const key of ['title','script','voice','orientation']) if (typeof input[key] === 'string') scene[key] = input[key].slice(0, key === 'script' ? 40000 : 150);
    if (input.orientation && !['landscape','portrait'].includes(input.orientation)) throw new Error('画面比例无效');
    if (input.rate !== undefined) scene.rate = Math.max(-5, Math.min(5, Number(input.rate) || 0));
    for (const key of ['loop','muted']) if (typeof input[key] === 'boolean') scene[key] = input[key];
    save(); broadcast('live:state', snapshot()); return snapshot();
  }
  async function chooseVideo(parent) {
    const result = await dialog.showOpenDialog(parent, { title: '选择循环讲解视频', filters: [{ name: '视频', extensions: ['mp4','webm','m4v','mov'] }], properties: ['openFile'] });
    if (!result.canceled && result.filePaths[0]) { scene.videoPath = result.filePaths[0]; save(); broadcast('live:state', snapshot()); }
    return snapshot();
  }
  function speech(payload) {
    return new Promise((resolve, reject) => {
      const speechScript = app.isPackaged ? path.join(process.resourcesPath,'app.asar.unpacked','electron','speech.ps1') : path.join(__dirname,'speech.ps1');
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', speechScript], { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      let out = '', err = ''; let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
      child.stdout.on('data', x => out += x.toString('utf8')); child.stderr.on('data', x => err += x.toString('utf8'));
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); if (code !== 0 || timedOut) reject(new Error(`Windows 语音不可用：${timedOut ? '合成超时' : err.slice(-600)}`)); else { try { resolve(JSON.parse(out.trim())); } catch { reject(new Error('Windows 语音返回格式异常')); } } });
      child.stdin.end(JSON.stringify(payload), 'utf8');
    });
  }
  async function synthesize(input) {
    const text = String(input.text || '').trim().slice(0,800);
    if (!text) throw new Error('念稿文本为空');
    const voice = String(input.voice || scene.voice || '').slice(0,150), rate = Math.max(-5,Math.min(5,Number(input.rate ?? scene.rate) || 0));
    const key = createHash('sha256').update(JSON.stringify([text,voice,rate])).digest('hex');
    const target = path.join(audioDir, key + '.wav');
    const task = synthQueue.then(async () => {
      if (!fs.existsSync(target)) {
        const temp = path.join(audioDir, randomUUID() + '.wav');
        try { await speech({ action:'speak', text, voice, rate, output:temp }); fs.renameSync(temp,target); }
        finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
        const cached = fs.readdirSync(audioDir).filter(f => f.endsWith('.wav')).map(f => ({ file:path.join(audioDir,f), time:fs.statSync(path.join(audioDir,f)).mtimeMs })).sort((a,b) => b.time-a.time);
        for (const old of cached.slice(100)) { try { fs.unlinkSync(old.file); } catch {} }
      }
      return { url:mediaUrl(target) };
    });
    synthQueue = task.catch(() => {}); return task;
  }
  function command(action) {
    if (!['start','pause','resume','stop'].includes(action)) throw new Error('直播动作无效');
    if (action === 'start' && !scene.script.trim() && !scene.videoPath) throw new Error('请先添加讲稿或视频');
    scene.status = action === 'start' || action === 'resume' ? 'running' : action === 'pause' ? 'paused' : 'stopped';
    save(); broadcast('live:state', snapshot()); return snapshot();
  }
  async function serve(request) {
    const url = new URL(request.url); const filePath = media.get(url.pathname.slice(1));
    if (!filePath || !fs.existsSync(filePath)) return new Response('Not found',{status:404});
    const size = fs.statSync(filePath).size;
    const type = { '.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.wav':'audio/wav' }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type':type,'Accept-Ranges':'bytes','Access-Control-Allow-Origin':'*' };
    const range = request.headers.get('range');
    let start=0,end=size-1,status=200;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) return new Response(null,{status:416});
      start = m[1] ? Number(m[1]) : Math.max(0,size-Number(m[2]));
      end = m[2] && m[1] ? Math.min(Number(m[2]),size-1) : size-1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>end || start>=size) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
      status=206; headers['Content-Range']=`bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length']=String(Math.max(0,end-start+1));
    return new Response(request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(filePath,{start,end})), {status,headers});
  }
  return { snapshot, update, chooseVideo, voices:() => speech({action:'voices'}), synthesize, command, serve };
}
module.exports = { createLiveStudio };
