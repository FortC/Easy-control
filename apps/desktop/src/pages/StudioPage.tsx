import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, ArrowRight } from "lucide-react";
import { api } from "../api.js";
import { PLATFORM_LABELS, CONTENT_STATUS_LABELS, fmtTime, fromLocalInput, toLocalInput } from "../format.js";

/** 内容工作台：生成 → 编辑 → 送审 → 审批 → 排程（第一个业务里程碑的界面闭环）。 */
export default function StudioPage() {
  const queryClient = useQueryClient();
  const contents = useQuery({ queryKey: ["contents"], queryFn: () => api("GET", "/contents"), refetchInterval: 8000 });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api("GET", "/accounts") });
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => api("GET", "/sources") });

  const [goal, setGoal] = useState("");
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, boolean>>({});
  const [selectedSources, setSelectedSources] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const prepare = useMutation({
    mutationFn: (body: unknown) => api("POST", "/contents/prepare", body),
    onSuccess: (result: any) => {
      setError(null);
      setActiveId(result.versions[0]?.id ?? null);
      void queryClient.invalidateQueries({ queryKey: ["contents"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const activeAccounts = (accounts.data?.accounts ?? []).filter((a: any) => !a.paused);
  const targets = Object.entries(selectedAccounts)
    .filter(([, on]) => on)
    .map(([id]) => {
      const account = activeAccounts.find((a: any) => a.id === id);
      return account ? { platform: account.platform, accountId: account.id } : null;
    })
    .filter(Boolean);
  const sourceIds = Object.entries(selectedSources)
    .filter(([, on]) => on)
    .map(([id]) => id);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>内容工作台</h1>
          <div className="sub">给助手一个目标，基于真实资料生成平台版本；审核后排程发布</div>
        </div>
      </div>

      <div className="card">
        <h2>新任务</h2>
        <div className="field">
          <label>运营目标</label>
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="例如：根据产品资料为下周准备一篇种草笔记和微博短博文"
          />
        </div>
        <div className="row" style={{ alignItems: "flex-start", marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: "var(--ink-2)" }}>发布账号（每个平台一个版本）</label>
            <div style={{ marginTop: 6 }}>
              {activeAccounts.map((account: any) => (
                <label key={account.id} className="row" style={{ gap: 6, marginBottom: 4, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={Boolean(selectedAccounts[account.id])}
                    onChange={(e) => setSelectedAccounts({ ...selectedAccounts, [account.id]: e.target.checked })}
                  />
                  {PLATFORM_LABELS[account.platform]} · {account.display_name}
                </label>
              ))}
              {activeAccounts.length === 0 && <div className="muted">先到「账号中心」连接账号</div>}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: "var(--ink-2)" }}>引用资料（不选则自动检索）</label>
            <div style={{ marginTop: 6, maxHeight: 120, overflowY: "auto" }}>
              {sources.data?.sources?.map((source: any) => (
                <label key={source.id} className="row" style={{ gap: 6, marginBottom: 4, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={Boolean(selectedSources[source.id])}
                    onChange={(e) => setSelectedSources({ ...selectedSources, [source.id]: e.target.checked })}
                  />
                  {source.title}
                </label>
              ))}
              {(sources.data?.sources?.length ?? 0) === 0 && <div className="muted">先到「资料与素材」添加真实资料</div>}
            </div>
          </div>
        </div>
        {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
        <button
          className="btn primary"
          disabled={goal.length < 2 || targets.length === 0 || prepare.isPending}
          onClick={() => prepare.mutate({ goal, targets, ...(sourceIds.length ? { sourceIds } : {}) })}
        >
          <Sparkles size={13} style={{ verticalAlign: -2 }} /> {prepare.isPending ? "生成中…" : "生成草稿"}
        </button>
      </div>

      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div className="card">
          <h2>内容版本</h2>
          <table className="list">
            <tbody>
              {contents.data?.contents?.map((content: any) => (
                <tr
                  key={content.id}
                  onClick={() => setActiveId(content.id)}
                  style={{ cursor: "pointer", background: activeId === content.id ? "var(--accent-soft)" : undefined }}
                >
                  <td>
                    <strong>{content.title}</strong>
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {PLATFORM_LABELS[content.platform]} · {fmtTime(content.created_at)}
                    </div>
                  </td>
                  <td>
                    <span
                      className={`chip ${
                        content.status === "approved" ? "ok" : content.status === "ready_for_review" ? "warn" : "muted"
                      }`}
                    >
                      {CONTENT_STATUS_LABELS[content.status]}
                    </span>
                  </td>
                  <td className="muted">{(content.citations ?? []).length} 条引用</td>
                </tr>
              ))}
              {(contents.data?.contents?.length ?? 0) === 0 && (
                <tr>
                  <td className="empty">暂无内容</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {activeId && <ContentDetail contentId={activeId} accounts={accounts.data?.accounts ?? []} />}
      </div>
    </div>
  );
}

function ContentDetail({ contentId, accounts }: { contentId: string; accounts: any[] }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["content", contentId], queryFn: () => api("GET", `/contents/${contentId}`) });
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [aiGenerated, setAiGenerated] = useState(true);
  const [commercial, setCommercial] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [mode, setMode] = useState<"single" | "recurring">("single");
  const [weekdays, setWeekdays] = useState<number[]>([1, 3, 5]);
  const [timeOfDay, setTimeOfDay] = useState("10:00");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const content = detail.data?.content;
  const activeApproval = (detail.data?.approvals ?? []).find((a: any) => a.status === "active");
  const account = accounts.find((a: any) => a.id === activeApproval?.account_id);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["content", contentId] });

  const startEdit = () => {
    setTitle(content.title);
    setBody(content.body);
    setAiGenerated(content.declarations?.aiGenerated ?? true);
    setCommercial(content.declarations?.commercial ?? false);
    setEditing(true);
  };

  const save = useMutation({
    mutationFn: () =>
      api("PUT", `/contents/${contentId}`, {
        title,
        body,
        topics: content.topics ?? [],
        declarations: { aiGenerated, commercial },
      }),
    onSuccess: () => {
      setEditing(false);
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });
  const submitReview = useMutation({
    mutationFn: () => api("POST", `/contents/${contentId}/ready-for-review`),
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });
  const approve = useMutation({
    mutationFn: () =>
      api("POST", `/content-versions/${contentId}/approve`, {
        accountId: selectedAccountId,
        action: publishAction,
        validMinutes: 24 * 60,
      }),
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });

  const platformAccount = accounts.find((a: any) => a.platform === content?.platform && !a.paused);
  const selectedAccountId = activeApproval?.account_id ?? platformAccount?.id;
  const publishAction =
    content?.platform === "xiaohongshu" ? "publish_image_note" : content?.platform === "weibo" ? "publish_post" : "publish_video";

  const schedule = useMutation({
    mutationFn: () =>
      api("POST", "/schedules", {
        mode,
        contentVersionId: contentId,
        approvalId: activeApproval.id,
        accountId: activeApproval.account_id,
        platform: content.platform,
        action: publishAction,
        ...(mode === "single"
          ? { at: fromLocalInput(scheduleAt) }
          : { weekdays, timeOfDay, startDate: new Date().toISOString().slice(0, 10) }),
      }),
    onSuccess: (result: any) => {
      setError(null);
      setMessage(`已排程，任务 ${result.taskId ?? "已创建"}；到「任务与日历」查看进度`);
      void queryClient.invalidateQueries({ queryKey: ["contents"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!content) return null;

  return (
    <div className="card">
      <h2>内容详情</h2>

      {editing ? (
        <>
          <div className="field">
            <label>标题</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label>正文</label>
            <textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            <label className="row" style={{ gap: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={aiGenerated} onChange={(e) => setAiGenerated(e.target.checked)} /> AI 生成声明
            </label>
            <label className="row" style={{ gap: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={commercial} onChange={(e) => setCommercial(e.target.checked)} /> 商业合作声明
            </label>
          </div>
          <div className="notice">保存后内容回到草稿，已有审批将失效，需要重新送审。</div>
          <div className="row">
            <button className="btn" onClick={() => setEditing(false)}>取消</button>
            <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>保存修改</button>
          </div>
        </>
      ) : (
        <>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <strong style={{ fontSize: 15 }}>{content.title}</strong>
            <span className="chip muted">{PLATFORM_LABELS[content.platform]}</span>
          </div>
          <div className="content-body">{content.body}</div>
          <div className="row" style={{ margin: "10px 0" }}>
            {(content.topics ?? []).map((topic: string) => (
              <span key={topic} className="chip muted">#{topic}</span>
            ))}
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted">
              AI 参与声明：{content.declarations?.aiGenerated ? "已声明" : "无"} ·{" "}
              {content.model_info ? `${content.model_info.provider}` : ""}
            </span>
            <button className="btn small" onClick={startEdit}>编辑</button>
          </div>
          {(content.citations ?? []).length > 0 && (
            <>
              <h2 style={{ marginTop: 14 }}>事实依据</h2>
              <ul className="timeline">
                {(content.citations ?? []).map((citation: any, index: number) => (
                  <li key={index}>
                    《{citation.sourceTitle}》：{citation.quote}
                  </li>
                ))}
              </ul>
            </>
          )}
          {(content.warnings ?? []).map((warning: string, index: number) => (
            <div key={index} className="notice" style={{ marginTop: 10 }}>{warning}</div>
          ))}

          <h2 style={{ marginTop: 16 }}>审核与排程</h2>
          {content.status === "draft" && (
            <button className="btn primary" onClick={() => submitReview.mutate()} disabled={submitReview.isPending}>
              送审 <ArrowRight size={12} style={{ verticalAlign: -2 }} />
            </button>
          )}
          {content.status === "ready_for_review" && platformAccount && (
            <div>
              <div className="field">
                <label>审批发布到</label>
                <div className="muted">
                  {PLATFORM_LABELS[content.platform]} · {platformAccount.display_name}
                </div>
              </div>
              <button className="btn primary" onClick={() => approve.mutate()} disabled={approve.isPending}>
                {approve.isPending ? "审批中…" : "批准（有效期 24 小时）"}
              </button>
            </div>
          )}
          {content.status === "ready_for_review" && !platformAccount && (
            <div className="error-text">没有可用的{PLATFORM_LABELS[content.platform]}账号，先到账号中心连接</div>
          )}
          {content.status === "approved" && activeApproval && (
            <>
              <div className="notice">
                已批准（{account?.display_name}），有效期至 {fmtTime(activeApproval.expires_at)}；审批后修改内容会使审批失效。
              </div>
              <div className="row" style={{ marginBottom: 10 }}>
                <span className={`chip ${mode === "single" ? "info" : "muted"}`} style={{ cursor: "pointer" }} onClick={() => setMode("single")}>
                  单次发布
                </span>
                <span className={`chip ${mode === "recurring" ? "info" : "muted"}`} style={{ cursor: "pointer" }} onClick={() => setMode("recurring")}>
                  周期计划
                </span>
              </div>
              {mode === "single" ? (
                <div className="field">
                  <label>发布时间（北京时间）</label>
                  <input
                    type="datetime-local"
                    value={scheduleAt || toLocalInput(new Date(Date.now() + 5 * 60_000))}
                    onChange={(e) => setScheduleAt(e.target.value)}
                  />
                </div>
              ) : (
                <div className="row" style={{ marginBottom: 10 }}>
                  {[["一", 1], ["二", 2], ["三", 3], ["四", 4], ["五", 5], ["六", 6], ["日", 7]].map(([label, day]) => (
                    <span
                      key={String(day)}
                      className={`chip ${weekdays.includes(day as number) ? "info" : "muted"}`}
                      style={{ cursor: "pointer" }}
                      onClick={() =>
                        setWeekdays(
                          weekdays.includes(day as number)
                            ? weekdays.filter((d) => d !== day)
                            : [...weekdays, day as number],
                        )
                      }
                    >
                      周{label}
                    </span>
                  ))}
                  <input type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} style={{ width: 110 }} />
                </div>
              )}
              <button
                className="btn primary"
                disabled={schedule.isPending || (mode === "single" && !scheduleAt)}
                onClick={() => schedule.mutate()}
              >
                {schedule.isPending ? "创建中…" : "创建排程"}
              </button>
            </>
          )}
        </>
      )}
      {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
      {message && <div className="notice" style={{ marginTop: 10 }}>{message}</div>}
    </div>
  );
}
