import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { fmtTime, PUBLICATION_LABELS, PLATFORM_LABELS } from "../format.js";
import { desktop } from '../native.js';
import { JobCard } from './CommandPage.js';

/** 结果与数据：发布回执、平台状态、指标与人工登记。 */
export default function ResultsPage() {
  const queryClient = useQueryClient();
  const cli = useQuery({queryKey:['native-tools'],queryFn:()=>desktop.tools.snapshot(),refetchInterval:5000});
  const publications = useQuery({
    queryKey: ["publications"],
    queryFn: () => api("GET", "/publications"),
    refetchInterval: 8000,
  });
  const [confirmUrl, setConfirmUrl] = useState<Record<string, string>>({});
  const manualConfirm = useMutation({
    mutationFn: ({ taskId, url }: { taskId: string; url: string }) =>
      api("POST", `/publications/${taskId}/manual-confirm`, { url }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["publications"] }),
  });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>结果与数据</h1>
          <div className="sub">提交回执、公开状态与可获取的指标；「已提交 ≠ 已公开」，状态如实展示</div>
        </div>
      </div>

      <div className="grid cols-4" style={{marginBottom:20}}>{[['CLI 任务',cli.data?.jobs.length||0],['已完成',cli.data?.jobs.filter(j=>j.status==='completed').length||0],['等待执行',cli.data?.jobs.filter(j=>j.status==='scheduled').length||0],['待核实 / 人工',cli.data?.jobs.filter(j=>['unknown','needs_human'].includes(j.status)).length||0]].map(([label,n])=><div key={label} className="stat"><div className="label">{label}</div><div className="num">{n}</div></div>)}</div>
      {(cli.data?.jobs.length||0)>0&&<div className="grid cols-2" style={{marginBottom:20}}>{cli.data?.jobs.slice(0,8).map(job=><JobCard key={job.id} job={job} refresh={()=>void cli.refetch()}/>)}</div>}
      <div className="card">
        <h2>内容发布回执与平台数据</h2>
        <table className="list">
          <thead>
            <tr>
              <th>平台</th>
              <th>内容</th>
              <th>公开状态</th>
              <th>确认来源</th>
              <th>平台 ID / 链接</th>
              <th>数据快照</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            {publications.data?.publications?.map((pub: any) => {
              const metrics = pub.latest_metrics;
              return (
                <tr key={pub.id}>
                  <td>{PLATFORM_LABELS[pub.platform]}</td>
                  <td>
                    {pub.content_title}
                    <div className="muted" style={{ fontSize: 11 }}>{pub.account_name}</div>
                  </td>
                  <td>
                    <span className={`chip ${pub.publication_status === "published" ? "ok" : pub.publication_status === "rejected" ? "danger" : "info"}`}>
                      {PUBLICATION_LABELS[pub.publication_status]}
                    </span>
                  </td>
                  <td className="muted">
                    {pub.confirmation_source === "platform_verified"
                      ? "平台核实"
                      : pub.confirmation_source === "manual"
                        ? "人工确认"
                        : "适配器回执"}
                  </td>
                  <td>
                    {pub.external_id && <div className="mono" style={{ fontSize: 11 }}>{pub.external_id}</div>}
                    {pub.url ? (
                      <a className="link" href={pub.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                        打开
                      </a>
                    ) : (
                      <div className="row" style={{ marginTop: 4 }}>
                        <input
                          style={{ width: 200, fontSize: 12 }}
                          placeholder="人工登记作品链接"
                          value={confirmUrl[pub.task_id] ?? ""}
                          onChange={(e) => setConfirmUrl({ ...confirmUrl, [pub.task_id]: e.target.value })}
                        />
                        <button
                          className="btn small"
                          disabled={!confirmUrl[pub.task_id]?.startsWith("http")}
                          onClick={() => manualConfirm.mutate({ taskId: pub.task_id, url: confirmUrl[pub.task_id] })}
                        >
                          登记
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {metrics
                      ? `曝光 ${metrics.impressions ?? "—"} · 赞 ${metrics.likes ?? "—"} · 评 ${metrics.comments ?? "—"}`
                      : "—"}
                  </td>
                  <td className="muted">{fmtTime(pub.updated_at)}</td>
                </tr>
              );
            })}
            {(publications.data?.publications?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={7} className="empty">暂无发布记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
