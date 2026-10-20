import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Bot,
  FolderOpen,
  PenSquare,
  CalendarClock,
  BarChart3,
  AlertTriangle,
  LogOut,
} from "lucide-react";
import { getToken, logout } from "./api.js";
import LoginPage from "./pages/LoginPage.js";
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
  const navigate = useNavigate();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          AI People <small>运营工作台</small>
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
          <span>v0.1 骨架</span>
          <button
            onClick={() => {
              logout();
              navigate("/login");
            }}
          >
            <LogOut size={12} style={{ verticalAlign: -2 }} /> 退出
          </button>
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

export default function App() {
  if (!getToken()) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/*" element={<Shell />} />
    </Routes>
  );
}
