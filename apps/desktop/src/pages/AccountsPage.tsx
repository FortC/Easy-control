import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../api.js";
import { PLATFORM_LABELS, CHANNEL_LABELS } from "../format.js";
import CliAccounts from '../components/CliAccounts.js';

const PLATFORMS = ["xiaohongshu", "weibo", "douyin", "zhihu"] as const;

export default function AccountsPage() {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api("GET", "/accounts"), refetchInterval: 8000 });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["accounts"] });
  const pause = useMutation({
    mutationFn: (id: string) => api("POST", `/accounts/${id}/pause`, { reason: "手动暂停" }),
    onSuccess: refresh,
  });
  const resume = useMutation({ mutationFn: (id: string) => api("POST", `/accounts/${id}/resume`), onSuccess: refresh });
  const disconnect = useMutation({
    mutationFn: (id: string) => api("DELETE", `/accounts/${id}`),
    onSuccess: refresh,
  });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>账号中心</h1>
          <div className="sub">管理平台 CLI 账号和授权；小红书只保留内容助手与人工交付工作区。</div>
        </div>
        <button className="btn primary" onClick={() => setShowAdd(true)}>
          <Plus size={13} style={{ verticalAlign: -2 }} /> 连接账号
        </button>
      </div>

      <CliAccounts />
      <div className="card">
        <h2>内容工作区与平台连接</h2>
        <table className="list">
          <thead>
            <tr>
              <th>平台 / 账号</th>
              <th>通道</th>
              <th>UID</th>
              <th>会话</th>
              <th>状态</th>
              <th>能力</th>
              <th style={{ width: 200 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.data?.accounts?.map((account: any) => (
              <tr key={account.id}>
                <td>
                  <strong>{PLATFORM_LABELS[account.platform]}</strong> · {account.display_name}
                  {account.risk_note && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {account.risk_note}
                    </div>
                  )}
                </td>
                <td>
                  <span className={`chip ${account.channel === "simulator" ? "info" : "muted"}`}>
                    {account.platform === "xiaohongshu" ? "人工交付工作区" : CHANNEL_LABELS[account.channel]}
                  </span>
                </td>
                <td className="mono">{account.uid}</td>
                <td>
                  <span className={`chip ${account.session_status === "active" ? "ok" : "danger"}`}>
                    {account.session_status === "active" ? "有效" : "失效"}
                  </span>
                </td>
                <td>
                  {account.paused ? <span className="chip danger">已暂停</span> : <span className="chip ok">正常</span>}
                  {account.paused_reason && <div className="muted" style={{ fontSize: 11 }}>{account.paused_reason}</div>}
                </td>
                <td className="muted">{(account.capabilities ?? []).join("、") || "—"}</td>
                <td>
                  <div className="row">
                    {account.paused ? (
                      <button className="btn small" onClick={() => resume.mutate(account.id)}>恢复</button>
                    ) : (
                      <button className="btn small" onClick={() => pause.mutate(account.id)}>暂停</button>
                    )}
                    <button
                      className="btn small danger"
                      onClick={() => {
                        if (confirm(`断开账号「${account.display_name}」？未开始的任务将被取消。`)) {
                          disconnect.mutate(account.id);
                        }
                      }}
                    >
                      断开
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {(accounts.data?.accounts?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  还没有连接账号；点击右上角「连接账号」创建模拟器账号即可体验完整流程
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <AddAccountModal onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); refresh(); }} />}
    </div>
  );
}

function AddAccountModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [platform, setPlatform] = useState<string>("xiaohongshu");
  const [channel, setChannel] = useState<string>("simulator");
  const [displayName, setDisplayName] = useState("");
  const [uid,setUid] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: unknown) => api("POST", "/accounts", body),
    onSuccess: onDone,
    onError: (err: Error) => setError(err.message),
  });

  const channels =
    platform === "xiaohongshu"
      ? ["simulator"]
      : platform === "weibo"
        ? ["simulator", "weibo_cli"]
        : platform === 'zhihu' ? ['simulator'] : ["simulator", "douyin_api"];

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>连接账号</h3>
        <div className="field">
          <label>平台</label>
          <div className="radio-cards">
            {PLATFORMS.map((p) => (
              <div
                key={p}
                className={`radio-card ${platform === p ? "selected" : ""}`}
                onClick={() => {
                  setPlatform(p);
                  setChannel(p === "xiaohongshu" ? "simulator" : "simulator");
                }}
              >
                {PLATFORM_LABELS[p]}
              </div>
            ))}
          </div>
        </div>
        <div className="field">
          <label>通道</label>
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            {channels.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
          <span className="hint">
            {channel === "simulator"
              ? platform === "xiaohongshu" ? "用于内容生成与审核归档；不保存小红书登录态，发布与互动由真人完成" : "演示通道：不连接真实平台，用于体验流程"
              : channel === "weibo_cli"
                ? "微博官方 CLI：需在执行设备安装 weibo-cli 并完成 OAuth"
                : "抖音官方 API：需开发者应用获批并完成账号 OAuth"}
          </span>
        </div>
        <div className="field">
          <label>显示名称</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="例如：山野茶事小红书号" />
        </div>
        {channel !== 'simulator' && <div className="field"><label>账号 UID</label><input value={uid} onChange={e=>setUid(e.target.value)} placeholder="填写需要绑定的真实平台账号 UID"/></div>}
        {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={create.isPending}
            onClick={() =>
              create.mutate({
                platform,
                channel,
                displayName: displayName || `${PLATFORM_LABELS[platform]}账号`,
                ...(uid ? {uid} : {}),
              })
            }
          >
            {create.isPending ? "保存中…" : platform === "xiaohongshu" ? "创建人工交付工作区" : "连接"}
          </button>
        </div>
      </div>
    </div>
  );
}
