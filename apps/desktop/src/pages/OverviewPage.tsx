import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, FileSearch, AlertTriangle, MonitorSmartphone, RefreshCw, KeyRound } from "lucide-react";
import { api } from "../api.js";
import { fmtTime, PUBLICATION_LABELS, PLATFORM_LABELS } from "../format.js";

export default function OverviewPage() {
  const queryClient = useQueryClient();
  const [pairCode, setPairCode] = useState<string | null>(null);
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api("GET", "/overview"),
    refetchInterval: 5000,
  });
  const events = useQuery({
    queryKey: ["events", "latest"],
    queryFn: () => api("GET", "/task-events?after=0&limit=15"),
    refetchInterval: 5000,
    select: (data: any) => [...data.events].reverse(),
  });
  const createPairCode = useMutation({
    mutationFn: () => api("POST", "/runners/pairing-codes"),
    onSuccess: (data: any) => {
      setPairCode(data.code);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  const data = overview.data;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>总览</h1>
          <div className="sub">今日任务、待处理事项与执行设备状态（每 5 秒自动刷新）</div>
        </div>
        <button className="btn small" onClick={() => void overview.refetch()}>
          <RefreshCw size={12} style={{ verticalAlign: -2 }} /> 刷新
        </button>
      </div>

      <div className="grid cols-4">
        <div className="stat">
          <div className="num">{data?.todayTasks ?? "—"}</div>
          <div className="label">
            <CalendarClock size={13} /> 今日任务
          </div>
        </div>
        <div className="stat">
          <div className="num">{data?.pendingReview ?? "—"}</div>
          <div className="label">
            <FileSearch size={13} /> 待审核内容
          </div>
        </div>
        <div className={`stat ${(data?.needsHuman ?? 0) > 0 || (data?.openIncidents ?? 0) > 0 ? "alert" : ""}`}>
          <div className="num">
            {(data?.needsHuman ?? 0) + (data?.openIncidents ?? 0)}
          </div>
          <div className="label">
            <AlertTriangle size={13} /> 需人工 / 异常
          </div>
        </div>
        <div className="stat">
          <div className="num">
            {data?.runners?.filter((r: any) => r.online).length ?? 0}/{data?.runners?.length ?? 0}
          </div>
          <div className="label">
            <MonitorSmartphone size={13} /> 执行设备在线
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>执行设备</h2>
          {(data?.runners?.length ?? 0) === 0 && <div className="empty">还没有绑定执行设备</div>}
          {data?.runners?.map((runner: any) => (
            <div key={runner.id} className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <div>
                {runner.name} <span className="muted mono">{runner.id.slice(0, 14)}</span>
              </div>
              <span className={`chip ${runner.online ? "ok" : "muted"}`}>{runner.online ? "在线" : "离线"}</span>
            </div>
          ))}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => createPairCode.mutate()} disabled={createPairCode.isPending}>
              <KeyRound size={12} style={{ verticalAlign: -2 }} /> 生成配对码
            </button>
            {pairCode && (
              <span className="mono">
                在设备上运行：<code>pnpm dev:runner -- --pair {pairCode}</code>
              </span>
            )}
          </div>
        </div>

        <div className="card">
          <h2>近期发布</h2>
          {(data?.recentPublications?.length ?? 0) === 0 && <div className="empty">暂无发布记录</div>}
          <table className="list">
            <tbody>
              {data?.recentPublications?.map((pub: any) => (
                <tr key={pub.id}>
                  <td>{PLATFORM_LABELS[pub.platform] ?? pub.platform}</td>
                  <td>{pub.content_title}</td>
                  <td>
                    <span className={`chip ${pub.publication_status === "published" ? "ok" : "info"}`}>
                      {PUBLICATION_LABELS[pub.publication_status]}
                    </span>
                  </td>
                  <td className="muted">{fmtTime(pub.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>最近事件</h2>
        <ul className="timeline">
          {events.data?.map((event: any) => (
            <li key={event.id}>
              <strong>{describeEvent(event.type)}</strong> · <span className="muted">{fmtTime(event.created_at)}</span>
              {event.task_id ? <span className="muted mono"> {event.task_id.slice(0, 12)}</span> : null}
            </li>
          ))}
          {(events.data?.length ?? 0) === 0 && <div className="empty">暂无事件</div>}
        </ul>
      </div>
    </div>
  );
}

function describeEvent(type: string): string {
  const labels: Record<string, string> = {
    "task.created": "新任务创建",
    "task.state_changed": "任务状态更新",
    "task.needs_human": "任务需要人工处理",
    "task.missed": "任务错过执行窗口",
    "task.cancelled": "任务已取消",
    "publication.submitted": "内容已提交平台",
    "publication.status_changed": "发布状态更新",
    "account.paused": "账号已暂停",
    "account.resumed": "账号已恢复",
    "incident.opened": "异常登记",
    "incident.resolved": "异常已处理",
    "runner.online": "执行设备上线",
    "runner.offline": "执行设备离线",
    "workspace.notice": "通知",
  };
  return labels[type] ?? type;
}
