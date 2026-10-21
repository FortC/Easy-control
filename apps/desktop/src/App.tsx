import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Users,
  Bot,
  FolderOpen,
  PenSquare,
  CalendarClock,
  BarChart3,
  AlertTriangle,
  RefreshCw,
  ServerOff,
} from "lucide-react";
import { currentApiBase, ensureLocalLogin, logout, onBackendFailed } from "./api.js";
import OverviewPage from "./pages/OverviewPage.js";
import AccountsPage from "./pages/AccountsPage.js";
import ModelsPage from "./pages/ModelsPage.js";
import LibraryPage from "./pages/LibraryPage.js";
import StudioPage from "./pages/StudioPage.js";
import TasksPage from "./pages/TasksPage.js";
import ResultsPage from "./pages/ResultsPage.js";
import IncidentsPage from "./pages/IncidentsPage.js";

const NAV = [
  { to: "/", label: "总览", icon: LayoutDashboard },
  { to: "/accounts", label: "账号中心", icon: Users },
  { to: "/studio", label: "内容工作台", icon: PenSquare },
  { to: "/tasks", label: "任务与日历", icon: CalendarClock },
  { to: "/results", label: "结果与数据", icon: BarChart3 },
  { to: "/incidents", label: "异常处理", icon: AlertTriangle },
  { to: "/library", label: "资料与素材", icon: FolderOpen },
  { to: "/models", label: "助手与模型", icon: Bot },
];

function Shell() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Bot size={16} strokeWidth={2} />
          </span>
          <div>
            AI People
            <br />
            <small>运营工作台</small>
          </div>
        </div>
        <nav>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
              <item.icon size={15} strokeWidth={1.8} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="side-footer">
          <span>个人版 v0.3</span>
          <span className="mono" style={{ fontSize: 10 }}>免登录模式</span>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/studio" element={<StudioPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/incidents" element={<IncidentsPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function ConnectingScreen() {
  return (
    <div className="login-wrap">
      <div className="login-card" style={{ textAlign: "center" }}>
        <span className="brand-mark" style={{ width: 44, height: 44, borderRadius: 10, margin: "0 auto 12px" }}>
          <Bot size={24} strokeWidth={2} />
        </span>
        <h1 style={{ fontSize: 17, margin: "0 0 6px" }}>AI People 运营工作台</h1>
        <div className="sub">正在连接本地后台服务…</div>
      </div>
    </div>
  );
}

function ConnectErrorScreen({ message }: { message: string }) {
  const [backend, setBackend] = useState(currentApiBase());
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="row" style={{ gap: 12, marginBottom: 14 }}>
          <span className="brand-mark" style={{ width: 40, height: 40, borderRadius: 10, background: "var(--danger)" }}>
            <ServerOff size={20} strokeWidth={2} />
          </span>
          <div>
            <h1 style={{ fontSize: 17, margin: 0 }}>无法连接后台服务</h1>
            <div className="sub">工作台需要后台 API 才能运行</div>
          </div>
        </div>
        <div className="notice" style={{ wordBreak: "break-all" }}>
          {message}
        </div>
        <ol className="muted" style={{ fontSize: 12, lineHeight: 1.9, paddingLeft: 18, margin: "0 0 14px" }}>
          <li>
            在项目目录启动后台：<code>pnpm db:up</code> 然后 <code>pnpm dev</code>
          </li>
          <li>后台部署在其他机器时，把下方地址改成对应服务器</li>
          <li>点击「重试连接」</li>
        </ol>
        <div className="field">
          <label>后台地址</label>
          <input value={backend} onChange={(e) => setBackend(e.target.value)} placeholder="http://localhost:8787" />
        </div>
        <button
          className="btn primary"
          style={{ width: "100%" }}
          onClick={() => {
            localStorage.setItem("aipeople_backend", backend.replace(/\/$/, ""));
            logout();
            // 地址可能已更改，重载页面让 api.ts 重新读取配置
            window.location.reload();
          }}
        >
          <RefreshCw size={13} style={{ verticalAlign: -2 }} /> 重试连接
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [phase, setPhase] = useState<"connecting" | "ready" | "error">("connecting");
  const [error, setError] = useState("");

  useEffect(() => {
    const off = onBackendFailed((message) => {
      setError(message);
      setPhase("error");
    });
    return off;
  }, []);

  async function connect() {
    setPhase("connecting");
    try {
      await ensureLocalLogin();
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  useEffect(() => {
    void connect();
  }, []);

  if (phase === "connecting") return <ConnectingScreen />;
  if (phase === "error") return <ConnectErrorScreen message={error} />;
  return (
    <Routes>
      <Route path="/*" element={<Shell />} />
    </Routes>
  );
}
