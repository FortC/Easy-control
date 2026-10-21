import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, Plus, Settings2, Terminal, Check, Search, FolderOpen } from 'lucide-react';
import { desktop, PLATFORM_NAMES, type CliTool } from '../native.js';

export default function CliPage(){
  const qc=useQueryClient(); const q=useQuery({queryKey:['native-tools'],queryFn:()=>desktop.tools.snapshot(),refetchInterval:5000});
  const [edit,setEdit]=useState<Partial<CliTool>|null>(null),[filter,setFilter]=useState('all'),[error,setError]=useState('');
  const install=useMutation({mutationFn:(id:string)=>desktop.tools.install(id),onSuccess:s=>{qc.setQueryData(['native-tools'],s);setError('');},onError:(e:Error)=>setError(e.message)});
  const tools=(q.data?.tools||[]).filter(t=>filter==='all'||t.platforms.includes(filter));
  return <div className="page-enter">
    <div className="page-head"><div><div className="eyebrow">INTEGRATIONS</div><h1>CLI 接入中心</h1><div className="sub">官方与开源工具，汇入同一个工作台。支持多个 CLI、独立账号与自定义动作。</div></div><button className="btn primary" onClick={()=>setEdit({name:'',platforms:['zhihu'],executable:'',actions:[{id:'help',label:'使用帮助',args:['--help'],kind:'read'}]})}><Plus size={15}/>导入本地 CLI</button></div>
    <div className="integration-banner"><div className="feature-symbol"><Terminal size={26}/></div><div><h2>让熟悉的工具，成为可编排的能力</h2><p>选择工具 → 安装或导入 → 连接自己的账号 → 在指令中心安排任务。</p></div><span className="chip info">应用内置 Node 运行环境</span></div>
    <div className="filter-tabs"><button className={filter==='all'?'selected':''} onClick={()=>setFilter('all')}>全部工具 <small>{q.data?.tools.length||0}</small></button>{Object.entries(PLATFORM_NAMES).map(([id,label])=><button key={id} className={filter===id?'selected':''} onClick={()=>setFilter(id)}>{label}</button>)}</div>
    {(error||q.error)&&<div className="notice error-text" role="alert">{error||String(q.error)}</div>}
    <div className="tool-grid">{tools.map(tool=><article className="tool-card" key={tool.id}>
      <div className="row" style={{justifyContent:'space-between'}}><div className={`tool-icon ${tool.source==='official'?'official':''}`}><Terminal size={23}/></div><span className={`chip ${tool.source==='official'?'info':'muted'}`}>{tool.source==='official'?'官方工具':tool.source==='custom'?'本地工具':'开源社区'}</span></div>
      <h2>{tool.name}</h2><p>{tool.description}</p><div className="platform-pills">{tool.platforms.map(p=><span key={p} className={`platform-pill ${p}`}>{PLATFORM_NAMES[p]}</span>)}</div>
      <div className="tool-metadata"><span>{tool.license}</span>{tool.stars!==undefined&&<span>☆ {tool.stars.toLocaleString()} <small>· {tool.checkedAt}</small></span>}</div>
      <div className="tool-actions"><button className={`btn ${tool.installed?'':'primary'}`} disabled={install.isPending} onClick={()=>tool.installed?setEdit(tool):tool.package?install.mutate(tool.id):setEdit(tool)}>{tool.installed?<><Check size={14}/>已安装 · 管理</>:install.isPending&&install.variables===tool.id?'正在下载与安装…':<><Download size={14}/>安装工具</>}</button><button className="icon-btn" title="编辑动作模板" onClick={()=>setEdit(tool)}><Settings2 size={16}/></button>{tool.repository&&<button className="icon-btn" title="查看工具来源" onClick={()=>void desktop.openExternal(tool.repository)}><ExternalLink size={16}/></button>}</div>
      {tool.installedVersion&&<div className="tool-version">已安装 v{tool.installedVersion} · {tool.actions.length} 个动作模板</div>}
    </article>)}</div>
    <div className="card quiet-note"><Search size={18}/><div><strong>工具开源免费，不代表平台调用免费</strong><p>微博服务、模型调用等以供应商规则计费。OpenCLI 需要按来源说明连接浏览器。知乎与抖音可经 OpenCLI 或导入的其他 CLI 接入；未验证的命令先用帮助与目录发现。</p></div></div>
    {edit&&<ToolEditor tool={edit} onClose={()=>setEdit(null)} onSaved={()=>{setEdit(null);void q.refetch();}}/>}
  </div>;
}
function ToolEditor({tool,onClose,onSaved}:{tool:Partial<CliTool>;onClose:()=>void;onSaved:()=>void}){
  const [name,setName]=useState(tool.name||''),[executable,setExecutable]=useState(tool.executable||''),[platforms,setPlatforms]=useState(tool.platforms||['zhihu']),[description,setDescription]=useState(tool.description||'');
  const [actions,setActions]=useState(JSON.stringify(tool.actions,null,2)),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function save(){setBusy(true);try{await desktop.tools.save({...tool,name,executable,platforms,description,actions:JSON.parse(actions)});onSaved();}catch(e){setError(String(e));}finally{setBusy(false);}}
  return <div className="modal-mask"><div className="modal wide"><div className="modal-head"><div><span className="eyebrow">TOOL SETTINGS</span><h3>配置 CLI 工具</h3></div><button className="icon-btn" onClick={onClose}>×</button></div>
    <div className="grid cols-2"><div className="field"><label>工具名称</label><input value={name} onChange={e=>setName(e.target.value)}/></div><div className="field"><label>适用平台</label><div className="row">{Object.entries(PLATFORM_NAMES).map(([id,label])=><label key={id} className="check-label"><input type="checkbox" checked={platforms.includes(id)} onChange={e=>setPlatforms(e.target.checked?[...platforms,id]:platforms.filter(p=>p!==id))}/>{label}</label>)}</div></div></div>
    <div className="field"><label>本地入口 · EXE / JS / CJS / MJS</label><div className="row"><input style={{flex:1}} value={executable} onChange={e=>setExecutable(e.target.value)} placeholder="选择你信任的 CLI 入口文件"/><button className="btn" onClick={async()=>{const p=await desktop.tools.choose();if(p)setExecutable(p);}}><FolderOpen size={15}/>选择</button></div></div>
    <div className="field"><label>说明</label><input value={description} onChange={e=>setDescription(e.target.value)}/></div>
    <div className="field"><label>动作模板</label><textarea className="code-input" rows={12} value={actions} onChange={e=>setActions(e.target.value)}/><span className="hint">参数以数组配置，不执行 Shell。使用 {'{query}、{text}、{title}、{url}、{image}'} 等占位符；外发动作 kind 必须设为 write。模型只能选择这些动作。</span></div>
    {error&&<div className="error-text" role="alert">{error}</div>}<div className="modal-footer"><button className="btn" onClick={onClose}>取消</button><button className="btn primary" onClick={()=>void save()} disabled={busy}>{busy?'保存中…':'保存配置'}</button></div>
  </div></div>;
}
