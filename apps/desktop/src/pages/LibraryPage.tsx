import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload, Trash2 } from "lucide-react";
import { api, uploadFile } from "../api.js";
import { SOURCE_KIND_LABELS, fmtTime } from "../format.js";

export default function LibraryPage() {
  const queryClient = useQueryClient();
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => api("GET", "/sources") });
  const assets = useQuery({ queryKey: ["assets"], queryFn: () => api("GET", "/assets") });
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [kind, setKind] = useState("product");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [copyright, setCopyright] = useState("品牌方提供");
  const [expiresAt, setExpiresAt] = useState("");

  const addSource = useMutation({
    mutationFn: () =>
      api("POST", "/sources", {
        kind,
        title,
        content,
        copyright,
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      }),
    onSuccess: () => {
      setTitle("");
      setContent("");
      setExpiresAt("");
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
    },
  });
  const removeSource = useMutation({
    mutationFn: (id: string) => api("DELETE", `/sources/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sources"] }),
  });

  async function onUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      await uploadFile("/assets", file);
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>资料与素材</h1>
          <div className="sub">真实资料是一切内容的事实来源；价格、参数等易变信息请设置有效期</div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>新增资料</h2>
          <div className="row" style={{ marginBottom: 12 }}>
            {Object.entries(SOURCE_KIND_LABELS).map(([value, label]) => (
              <span
                key={value}
                className={`chip ${kind === value ? "info" : "muted"}`}
                style={{ cursor: "pointer" }}
                onClick={() => setKind(value)}
              >
                {label}
              </span>
            ))}
          </div>
          <div className="field">
            <label>标题</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：产品资料：桂花乌龙 100g" />
          </div>
          <div className="field">
            <label>内容（真实、可核实）</label>
            <textarea
              rows={5}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="产品参数、真实案例、品牌介绍等；模型只依据这些资料创作"
            />
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label>版权来源</label>
              <input value={copyright} onChange={(e) => setCopyright(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>有效期（易变信息）</label>
              <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </div>
          </div>
          <button className="btn primary" disabled={!title || !content || addSource.isPending} onClick={() => addSource.mutate()}>
            保存资料
          </button>
        </div>

        <div className="card">
          <h2>素材库</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <input
              ref={fileInput}
              type="file"
              style={{ display: "none" }}
              accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onUpload(file);
                e.target.value = "";
              }}
            />
            <button className="btn" disabled={uploading} onClick={() => fileInput.current?.click()}>
              <Upload size={12} style={{ verticalAlign: -2 }} /> {uploading ? "上传中…" : "上传图片 / 视频"}
            </button>
            <span className="muted" style={{ fontSize: 11 }}>jpg / png / webp / gif / mp4，≤50MB</span>
          </div>
          {uploadError && <div className="error-text" style={{ marginBottom: 8 }}>{uploadError}</div>}
          <table className="list">
            <tbody>
              {assets.data?.assets?.map((asset: any) => (
                <tr key={asset.id}>
                  <td className="mono">{asset.id.slice(0, 16)}</td>
                  <td>{asset.mime_type}</td>
                  <td className="num">{(asset.size_bytes / 1024).toFixed(0)} KB</td>
                  <td className="muted">{fmtTime(asset.created_at)}</td>
                </tr>
              ))}
              {(assets.data?.assets?.length ?? 0) === 0 && (
                <tr>
                  <td className="empty">暂无素材</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>资料清单（{sources.data?.sources?.length ?? 0}）</h2>
        <table className="list">
          <thead>
            <tr>
              <th>类型</th>
              <th>标题与内容</th>
              <th>版权</th>
              <th>有效期</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sources.data?.sources?.map((source: any) => {
              const expired = source.expires_at && new Date(source.expires_at).getTime() < Date.now();
              return (
                <tr key={source.id}>
                  <td>
                    <span className="chip muted">{SOURCE_KIND_LABELS[source.kind]}</span>
                  </td>
                  <td>
                    <strong>{source.title}</strong>
                    <div className="muted" style={{ maxWidth: 520, whiteSpace: "pre-wrap", marginTop: 2 }}>
                      {source.content.length > 140 ? `${source.content.slice(0, 140)}…` : source.content}
                    </div>
                  </td>
                  <td className="muted">{source.copyright ?? "—"}</td>
                  <td>
                    {source.expires_at ? (
                      <span className={`chip ${expired ? "danger" : "warn"}`}>
                        {expired ? "已过期" : fmtTime(source.expires_at).slice(0, 10)}
                      </span>
                    ) : (
                      <span className="muted">长期</span>
                    )}
                  </td>
                  <td>
                    <button className="btn small danger" onClick={() => removeSource.mutate(source.id)}>
                      <Trash2 size={11} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
