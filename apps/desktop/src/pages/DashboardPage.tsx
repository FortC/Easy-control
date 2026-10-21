import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ArrowRight, Terminal, Radio, CalendarClock, CheckCheck, Layers, Activity, Plus } from 'lucide-react';
import { api } from '../api.js';
import { desktop, JOB_LABELS, PLATFORM_NAMES } from '../native.js';
import { fmtTime } from '../format.js';
export default function DashboardPage(){
 const native=useQuery({queryKey:['native-tools'],queryFn:()=>desktop.tools.snapshot(),refetchInterval:4000});
 const overview=useQuery({queryKey:['overview'],queryFn:()=>api<any>('GET','/overview'),refetchInterval:8000});
 const scene=useQuery({queryKey:['live-scene'],queryFn:()=>desktop.live.get(),refetchInterval:8000});
 const jobs=native.data?.jobs||[], tools=native.data?.tools||[], accounts=native.data?.accounts||[];
 const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
 const todayJobs=jobs.filter(j=>new Date(j.createdAt).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})===today);
 const days=Array.from({length:7},(_,i)=>{const date=new Date(Date.now()-(6-i)*86400000);const day=date.toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});return {label:date.toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'}),value:jobs.filter(j=>j.createdAt.slice(0,10)===day).length};});const max=Math.max(1,...days.map(d=>d.value));
 return <div className="page-enter"><div className="page-head"><div><div className="eyebrow">WORKSPACE OVERVIEW</div><h1>每一次运营，都有条不紊。</h1><div className="sub">把内容、工具与直播放在一起，专注今天需要完成的事。</div></div><Link className="btn primary" to="/commands"><Plus size={16}/>新建指令</Link></div>
 <div className="dashboard-hero"><div><span className="hero-kicker"><i/> 独立 Windows 工作空间</span><h2>连接你的平台。<br/>让想法，成为行动。</h2><p>微博、知乎、抖音、小红书，统一调度。<br/>从一条指令，到一次有结果的执行。</p><div className="row"><Link to="/cli" className="hero-button">连接第一个工具 <ArrowRight size={16}/></Link><Link to="/live" className="hero-link">开始一场讲解 <ArrowUpRight size={15}/></Link></div></div><div className="hero-platforms">{Object.entries(PLATFORM_NAMES).map(([id,name],i)=><div key={id} className={`hero-platform hero-platform-${i}`}><span className={`platform-logo ${id}`}>{name.slice(0,1)}</span><div><strong>{name}</strong><span>{accounts.filter(a=>a.platform===id).length} 个 CLI 账号配置</span></div><span className="platform-ready">{tools.some(t=>t.installed&&t.platforms.includes(id))?'工具已就绪':'待接入'}</span></div>)}</div></div>
 <div className="grid cols-4 dashboard-stats">{[
  {icon:Terminal,label:'已接入工具',value:tools.filter(t=>t.installed).length,caption:`共 ${tools.length} 个工具配置`},
  {icon:Activity,label:'今日执行任务',value:todayJobs.length+(overview.data?.todayTasks||0),caption:'本地指令与内容排程'},
  {icon:CheckCheck,label:'CLI 已完成',value:jobs.filter(j=>j.status==='completed').length,caption:'真实命令回执 · 不等于公开状态'},
  {icon:CalendarClock,label:'等待执行',value:jobs.filter(j=>j.status==='scheduled').length,caption:'软件在托盘运行即可调度'},
 ].map(s=><div className="stat" key={s.label}><div className="stat-heading"><span>{s.label}</span><s.icon size={17}/></div><div className="num">{native.isLoading?'—':s.value}</div><small>{s.caption}</small></div>)}</div>
 <div className="dashboard-bottom"><section className="card"><div className="toolbar"><div><h2>最近七天的指令</h2><span className="muted">来自本机的实际任务记录</span></div><span className="chip muted">{jobs.length} 条记录</span></div><div className="activity-chart">{days.map(d=><div className="chart-column" key={d.label}><span>{d.value}</span><div className="chart-track"><div style={{height:`${d.value?Math.max(8,d.value/max*100):2}%`}}/></div><small>{d.label}</small></div>)}</div></section><section className="card live-launch"><span className="feature-symbol"><Radio size={23}/></span><h2>你的下一场产品讲解</h2><p>视频循环播放、离线语音念稿，<br/>画面与讲稿在一个窗口里就绪。</p><div className="row"><span className={`chip ${scene.data?.status==='running'?'ok':'muted'}`}>{scene.data?.status==='running'?'正在讲解':'直播场景待启动'}</span></div><Link className="btn" to="/live">进入直播工作台 <ArrowUpRight size={15}/></Link></section></div>
 <section className="card"><div className="toolbar"><div><h2>最近操作</h2><span className="muted">执行记录和结果，随时可追溯。</span></div><Link className="text-btn" to="/commands">查看全部 <ArrowRight size={14}/></Link></div>{jobs.length?<table className="list"><thead><tr><th>动作</th><th>平台 / 账号</th><th>状态</th><th>时间</th><th>结果</th></tr></thead><tbody>{jobs.slice(0,5).map(j=><tr key={j.id}><td><strong>{j.actionLabel}</strong></td><td>{PLATFORM_NAMES[j.platform]} · {j.accountName}</td><td><span className={`chip ${j.status==='completed'?'ok':j.status==='failed'?'warn':'info'}`}>{JOB_LABELS[j.status]}</span></td><td className="muted">{fmtTime(j.createdAt)}</td><td className="muted">{j.summary}</td></tr>)}</tbody></table>:<div className="empty-state compact"><Layers size={28}/><h3>工作空间已经准备好</h3><p>先连接一个 CLI 工具，再创建第一条指令。这里会记录每一次执行。</p><Link to="/cli" className="btn">前往接入中心 <ArrowUpRight size={14}/></Link></div>}</section>
 </div>;
}
