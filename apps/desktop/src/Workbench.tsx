import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LayoutDashboard, Users, Bot, FolderOpen, PenSquare, CalendarClock, BarChart3, AlertTriangle, Terminal, Radio, PanelsTopLeft, ArrowUpRight, CircleHelp, RefreshCw, Command, ShieldCheck } from 'lucide-react';
import { ensureLocalLogin, onBackendFailed } from './api.js';
import { desktop } from './native.js';
import DashboardPage from './pages/DashboardPage.js';
import AccountsPage from './pages/AccountsPage.js';
import ModelsPage from './pages/ModelsPage.js';
import LibraryPage from './pages/LibraryPage.js';
import StudioPage from './pages/StudioPage.js';
import TasksPage from './pages/TasksPage.js';
import ResultsPage from './pages/ResultsPage.js';
import IncidentsPage from './pages/IncidentsPage.js';
import CliPage from './pages/CliPage.js';
import CommandPage from './pages/CommandPage.js';
import LivePage from './pages/LivePage.js';
import StagePage from './pages/StagePage.js';
import AboutPage from './pages/AboutPage.js';
const groups=[
 {label:'工作空间',items:[{to:'/',label:'工作总览',icon:LayoutDashboard},{to:'/commands',label:'指令中心',icon:Command},{to:'/studio',label:'内容工作台',icon:PenSquare},{to:'/live',label:'直播工作台',icon:Radio}]},
 {label:'连接与资源',items:[{to:'/cli',label:'CLI 接入中心',icon:Terminal},{to:'/accounts',label:'账号中心',icon:Users},{to:'/models',label:'助手与模型',icon:Bot},{to:'/library',label:'资料与素材',icon:FolderOpen}]},
 {label:'执行与洞察',items:[{to:'/tasks',label:'任务与日历',icon:CalendarClock},{to:'/results',label:'结果与数据',icon:BarChart3},{to:'/incidents',label:'异常处理',icon:AlertTriangle}]},
];
function Shell(){
 const loc=useLocation();const [version,setVersion]=useState('');useEffect(()=>{void desktop.appInfo().then(i=>setVersion(i.version));},[]);
 const current=groups.flatMap(g=>g.items).find(i=>i.to===loc.pathname)?.label||'关于软件';
 return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark"><PanelsTopLeft size={21}/></span><div>Easy Control<small>运营与直播工作台</small></div></div><div className="workspace-tag"><span className="workspace-avatar">EC</span><div>我的工作空间<small><i/> 本机独立运行</small></div><ShieldCheck size={15}/></div><nav>{groups.map(g=><div className="nav-group" key={g.label}><span className="nav-label">{g.label}</span>{g.items.map(item=><NavLink aria-label={item.label} key={item.to} to={item.to} end={item.to==='/'} className={({isActive})=>isActive?'active':''}><item.icon size={17} strokeWidth={1.7}/>{item.label}{item.to==='/live'&&<span className="nav-new">NEW</span>}</NavLink>)}</div>)}</nav><div className="side-footer"><NavLink to="/about"><CircleHelp size={16}/>关于与帮助</NavLink><span>v{version||'…'}</span></div></aside><div className="workspace-main"><header className="topbar"><div><span>我的工作空间</span><span className="breadcrumb-separator">/</span><strong>{current}</strong></div><div className="topbar-right"><span className="local-status"><i/> 本地引擎已就绪</span><button className="icon-btn" title="项目与反馈" onClick={()=>void desktop.openExternal('https://github.com/FortC/Easy-control')}><ArrowUpRight size={18}/></button><span className="user-avatar">我</span></div></header><main className="main"><Routes><Route path="/" element={<DashboardPage/>}/><Route path="/commands" element={<CommandPage/>}/><Route path="/cli" element={<CliPage/>}/><Route path="/live" element={<LivePage/>}/><Route path="/accounts" element={<AccountsPage/>}/><Route path="/studio" element={<StudioPage/>}/><Route path="/tasks" element={<TasksPage/>}/><Route path="/results" element={<ResultsPage/>}/><Route path="/incidents" element={<IncidentsPage/>}/><Route path="/models" element={<ModelsPage/>}/><Route path="/library" element={<LibraryPage/>}/><Route path="/about" element={<AboutPage/>}/><Route path="*" element={<Navigate to="/" replace/>}/></Routes></main></div></div>;
}
export default function Workbench(){
 const location=useLocation(); const stage=location.pathname==='/stage';
 const [phase,setPhase]=useState<'connecting'|'ready'|'error'>('connecting'),[error,setError]=useState('');
 async function connect(){setPhase('connecting');try{await ensureLocalLogin();setPhase('ready');}catch(e){setError(e instanceof Error?e.message:String(e));setPhase('error');}}
 useEffect(()=>{if(stage)return;const off=onBackendFailed(m=>{setError(m);setPhase('error');});void connect();return off;},[stage]);
 if(stage)return <StagePage/>;
 if(phase==='ready')return <Shell/>;
 return <div className="boot-screen"><div className="boot-card"><span className="brand-mark"><PanelsTopLeft size={30}/></span><div className="eyebrow">YOUR LOCAL WORKSPACE</div><h1>Easy Control</h1><p>{phase==='error'?'本地引擎启动遇到问题':'正在准备你的运营与直播工作空间'}</p>{phase==='error'?<><pre className="code">{error}</pre><button className="btn primary" onClick={()=>void connect()}><RefreshCw size={15}/>重试</button><button className="btn" onClick={()=>void desktop.openData()}>打开数据目录</button></>:<><div className="boot-progress"><span/></div><small>首次启动会初始化本地数据库，无需安装或启动额外服务。</small></>}</div></div>;
}

