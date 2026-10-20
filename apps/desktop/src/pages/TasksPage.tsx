import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { fmtTime, STATE_LABELS, PLATFORM_LABELS, CHANNEL_LABELS } from "../format.js";

function stateChipClass(status: string): string {
  if (status === "PUBLISHED") return "ok";
  if (["NEEDS_HUMAN", "UNKNOWN", "FAILED", "REJECTED"].includes(status)) return "danger";
  if (["MISSED", "CANCELLED"].includes(status)) return "muted";
  if (["RUNNING", "SUBMITTED", "UNDER_REVIEW", "WAITING_RUNNER", "PREFLIGHT"].includes(status)) return "info";
  return "muted";
}

export default function TasksPage() {
  const [filter, setFilter] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const tasks = useQuery({
    queryKey: ["tasks", filter],
    queryFn: () => api("GET", `/tasks${filter ? `?status=${filter}` : ""}`),
    refetchInterval: 5000,
  });
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: () => api("GET", "/schedules"), refetchInterval: 10000 });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>任务与日历</h1>
          <div className="sub">定时任务状态与周期计划；错过执行窗口 30 分钟默认标记 MISSED</div>
        </div>
      </div>

      <div className="card">
        <h2>周期计划（{schedules.data?.schedules?.length ?? 0}）</h2>
        <table className="list">
          <thead>
            <tr>
              <th>计划</th>
              <th>平台 / 账号</th>
              <th>内容</th>
              <th>规则</th>
              <th>待执行</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {schedules.data?.schedules?.map((schedule: any) => (
              <tr key={schedule.id}>
                <td className="mono">{schedule.id.slice(0, 16)}</td>
                <td>
                  {PLATFORM_LABELS[schedule.platform]} · {schedule.account_name}
                </td>
                <td>{schedule.content_title}</td>
                <td className="muted">
                  {schedule.mode === "single"
                    ? fmtTime(schedule.at)
                    : `每周${(schedule.weekdays ?? []).map(weekdayLabel).join("、")} ${schedule.timeOfDay}（北京时间）`}
                </td>
                <td className="num">{Number(schedule.upcoming_count)}</td>
                <td>
                  <ScheduleControls schedule={schedule} />
                </td>
              </tr>
            ))}
            {(schedules.data?.schedules?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  暂无计划；在内容工作台审批后创建
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="toolbar">
          <h2 style={{ margin: 0 }}>任务</h2>
          <div className="row">
            {["", "SCHEDULED", "WAITING_RUNNER", "RUNNING", "SUBMITTED", "PUBLISHED", "NEEDS_HUMAN", "UNKNOWN", "MISSED", "FAILED", "CANCELLED"].map(
              (status) => (
                <span
                  key={status}
                  className={`chip ${filter === status ? "info" : "muted"}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => setFilter(status)}
                >
                  {status === "" ? "全部" : STATE_LABELS[status]}
                </span>
              ),
            )}
          </div>
        </div>
        <table className="list">
          <thead>
            <tr>
              <th>执行时间</th>
              <th>内容</th>
              <th>平台 / 账号 / 通道</th>
              <th>状态</th>
              <th>公开状态</th>
              <th>更新</th>
            </tr>
          </thead>
          <tbody>
            {tasks.data?.tasks?.map((task: any) => (
              <tr
                key={task.id}
                style={{ cursor: "pointer" }}
                onClick={() => setActiveId(task.id)}
              >
                <td>{fmtTime(task.occurrence_at)}</td>
                <td>{task.content_title}</td>
                <td>
                  {PLATFORM_LABELS[task.platform]} · {task.account_name}
                  <div className="muted" style={{ fontSize: 11 }}>{CHANNEL_LABELS[task.channel] ?? task.channel}</div>
                </td>
                <td>
                  <span className={`chip ${stateChipClass(task.status)}`}>{STATE_LABELS[task.status] ?? task.status}</span>
                  {task.last_error?.message && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 2, maxWidth: 260 }}>{task.last_error.message}</div>
                  )}
                </td>
                <td className="muted">{task.publication_status ?? "—"}</td>
                <td className="muted">{fmtTime(task.updated_at)}</td>
              </tr>
            ))}
            {(tasks.data?.tasks?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={6} className="empty">暂无任务</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {activeId && <TaskDetail taskId={activeId} onClose={() => setActiveId(null)} />}
    </div>
  );
}

function weekdayLabel(day: number): string {
  return ["一", "二", "三", "四", "五", "六", "日"][day - 1] ?? String(day);
}

function ScheduleControls({ schedule }: { schedule: any }) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (active: boolean) => api("PATCH", `/schedules/${schedule.id}`, { active }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["schedules"] }),
  });
  return schedule.active ? (
    <button className="btn small" onClick={() => update.mutate(false)}>暂停</button>
  ) : (
    <span className="chip muted">已暂停</span>
  );
}

function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["task", taskId], queryFn: () => api("GET", `/tasks/${taskId}`), refetchInterval: 4000 });
  const cancel = useMutation({
    mutationFn: () => api("POST", `/tasks/${taskId}/cancel`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
  });
  const reschedule = useMutation({
    mutationFn: () => api("POST", `/tasks/${taskId}/resolve`, { decision: "reschedule" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
  });
  const task = detail.data?.task;
  const publication = detail.data?.publication;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>任务 {taskId}</h3>
        {task && (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <span className={`chip ${stateChipClass(task.status)}`}>{STATE_LABELS[task.status]}</span>
              <span className="muted">{PLATFORM_LABELS[task.platform]} · {task.action}</span>
              <span className="muted">{fmtTime(task.occurrence_at)}（北京时间）</span>
            </div>
            <div className="field">
              <label>内容</label>
              <div className="content-body">{task.content_body}</div>
            </div>
            {task.last_error?.message && <div className="notice">{task.last_error.message}</div>}
            {publication && (
              <div className="field">
                <label>发布记录</label>
                <div className="row">
                  <span className="chip muted">{publication.publication_status}</span>
                  {publication.external_id && <span className="mono">{publication.external_id}</span>}
                  {publication.url && (
                    <a className="link" href={publication.url} target="_blank" rel="noreferrer">
                      打开链接
                    </a>
                  )}
                </div>
              </div>
            )}
            <div className="field">
              <label>执行尝试</label>
              <table className="list">
                <tbody>
                  {detail.data?.attempts?.map((attempt: any) => (
                    <tr key={attempt.id}>
                      <td>#{attempt.attempt_no}</td>
                      <td>{attempt.outcome ?? "进行中"}</td>
                      <td className="muted">{fmtTime(attempt.started_at)}</td>
                      <td className="muted" style={{ fontSize: 11 }}>{attempt.error_message ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="field">
              <label>事件</label>
              <ul className="timeline">
                {detail.data?.events?.slice(-8).map((event: any) => (
                  <li key={event.id}>
                    {event.payload?.from ? `${event.payload.from} → ${event.payload.to}` : event.type} ·{" "}
                    <span className="muted">{fmtTime(event.created_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              {task.status === "NEEDS_HUMAN" && (
                <button className="btn" onClick={() => reschedule.mutate()} disabled={reschedule.isPending}>
                  人工已处理，5 分钟后重试
                </button>
              )}
              {["SCHEDULED", "WAITING_RUNNER", "NEEDS_HUMAN"].includes(task.status) && (
                <button className="btn danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                  取消任务
                </button>
              )}
              <button className="btn" onClick={onClose}>关闭</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
