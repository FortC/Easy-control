import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setToken, API_BASE } from "../api.js";

export default function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("admin@aipeople.dev");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "login"
          ? await api("POST", "/auth/login", { email, password })
          : await api("POST", "/auth/register", { email, password, displayName, workspaceName });
      setToken(result.token);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>AI People 运营工作台</h1>
        <div className="sub">
          抖音 · 小红书 · 微博｜{mode === "login" ? "登录工作空间" : "创建工作空间"}
        </div>
        {mode === "register" && (
          <>
            <div className="field">
              <label>你的称呼</label>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required placeholder="例如：运营小张" />
            </div>
            <div className="field">
              <label>工作空间名称</label>
              <input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} required placeholder="例如：山野茶事运营组" />
            </div>
          </>
        )}
        <div className="field">
          <label>邮箱</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label>密码</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} placeholder="至少 8 位" />
        </div>
        {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
        <button className="btn primary" style={{ width: "100%" }} disabled={busy}>
          {busy ? "处理中…" : mode === "login" ? "登录" : "创建并进入"}
        </button>
        <div className="row" style={{ marginTop: 14, justifyContent: "space-between" }}>
          <button
            type="button"
            className="btn small"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? "创建新工作空间" : "返回登录"}
          </button>
          <span className="muted" style={{ fontSize: 11 }}>
            后端 {API_BASE}
          </span>
        </div>
      </form>
    </div>
  );
}
