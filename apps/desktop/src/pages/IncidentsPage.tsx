import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { fmtTime } from "../format.js";

/** 异常处理：登录失效、验证码、声明缺失、结果未确认等，全部给出处理入口。 */
export default function IncidentsPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"open" | "resolved" | "all">("open");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const incidents = useQuery({
    queryKey: ["incidents", statusFilter],
    queryFn: () => api("GET", `/incidents?status=${statusFilter}`),
    refetchInterval: 8000,
  });
  const resolve = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => api("POST", `/incidents/${id}/resolve`, { note }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["incidents"] }),
  });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>异常处理</h1>
          <div className="sub">验证码、会话失效、结果未确认、错过窗口等；处理后按指引恢复对应能力</div>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <h2 style={{ margin: 0 }}>异常记录</h2>
          <div className="row">
            {(["open", "resolved", "all"] as const).map((status) => (
              <span
                key={status}
                className={`chip ${statusFilter === status ? "info" : "muted"}`}
                style={{ cursor: "pointer" }}
                onClick={() => setStatusFilter(status)}
              >
                {status === "open" ? "未处理" : status === "resolved" ? "已处理" : "全部"}
              </span>
            ))}
          </div>
        </div>
        <table className="list">
          <thead>
            <tr>
              <th>类型</th>
              <th>说明</th>
              <th>关联</th>
              <th>发生时间</th>
              <th>状态 / 处理</th>
            </tr>
          </thead>
          <tbody>
            {incidents.data?.incidents?.map((incident: any) => (
              <tr key={incident.id}>
                <td>
                  <span className={`chip ${incident.status === "open" ? "danger" : "muted"}`}>{describeKind(incident.kind)}</span>
                </td>
                <td style={{ maxWidth: 360 }}>
                  {incident.detail?.message ?? incident.detail?.reason ?? "—"}
                  {incident.detail?.externalId && (
                    <div className="muted mono" style={{ fontSize: 11 }}>平台 ID：{incident.detail.externalId}</div>
                  )}
                  {incident.resolution_note && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>处理备注：{incident.resolution_note}</div>
                  )}
                </td>
                <td className="muted" style={{ fontSize: 11 }}>
                  {incident.account_name && <div>{incident.account_name}</div>}
                  {incident.task_id && <div className="mono">{incident.task_id.slice(0, 16)}</div>}
                  {incident.content_title && <div>{incident.content_title}</div>}
                </td>
                <td className="muted">{fmtTime(incident.created_at)}</td>
                <td>
                  {incident.status === "open" ? (
                    <div className="row">
                      <input
                        style={{ width: 180, fontSize: 12 }}
                        placeholder="处理备注（可选）"
                        value={notes[incident.id] ?? ""}
                        onChange={(e) => setNotes({ ...notes, [incident.id]: e.target.value })}
                      />
                      <button
                        className="btn small"
                        onClick={() => resolve.mutate({ id: incident.id, note: notes[incident.id] ?? "" })}
                        disabled={resolve.isPending}
                      >
                        标记已处理
                      </button>
                    </div>
                  ) : (
                    <span className="chip ok">已处理 · {fmtTime(incident.resolved_at)}</span>
                  )}
                </td>
              </tr>
            ))}
            {(incidents.data?.incidents?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={5} className="empty">没有{statusFilter === "open" ? "未处理的" : ""}异常，一切正常</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function describeKind(kind: string): string {
  const known: Record<string, string> = {
    account_paused: "账号已暂停",
    task_missed: "任务错过窗口",
    submission_unknown: "提交结果未确认",
    reconcile_unconfirmed: "对账未确认",
    "adapter_needs_verify": "平台要求验证",
    "adapter_session_expired": "会话失效",
    "adapter_ip_blocked": "IP 被封锁",
  };
  if (known[kind]) return known[kind];
  if (kind.startsWith("adapter_")) return `适配器异常（${kind.slice(8)}）`;
  if (kind.startsWith("preflight_")) return `发布前检查未过（${kind.slice(10)}）`;
  return kind;
}
