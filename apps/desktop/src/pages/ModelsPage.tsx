import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Zap } from "lucide-react";
import { api } from "../api.js";

/** 助手与模型：供应商配置、连接测试、品牌口吻与预算。 */
export default function ModelsPage() {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ["model-providers"], queryFn: () => api("GET", "/model-providers") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api("GET", "/settings") });
  const [showAdd, setShowAdd] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["model-providers"] });
  const setDefault = useMutation({
    mutationFn: (id: string) => api("PATCH", `/model-providers/${id}`, { isDefault: true }),
    onSuccess: invalidate,
  });
  const toggleEnabled = useMutation({
    mutationFn: (provider: any) => api("PATCH", `/model-providers/${provider.id}`, { enabled: !provider.enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api("DELETE", `/model-providers/${id}`),
    onSuccess: invalidate,
  });
  const test = useMutation({
    mutationFn: (id: string) => api("POST", `/model-providers/${id}/test`),
    onSuccess: (result: any, id: string) =>
      setTestResult((prev) => ({ ...prev, [id]: result.ok ? `✓ ${result.message}` : `✗ ${result.message}` })),
  });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>助手与模型</h1>
          <div className="sub">模型只负责生成内容建议，不接触账号凭据与执行权限</div>
        </div>
        <button className="btn primary" onClick={() => setShowAdd(true)}>
          <Plus size={13} style={{ verticalAlign: -2 }} /> 添加供应商
        </button>
      </div>

      <div className="card">
        <h2>模型供应商</h2>
        <table className="list">
          <thead>
            <tr>
              <th>名称</th>
              <th>适配</th>
              <th>模型</th>
              <th>单价（元/百万 tokens）</th>
              <th>状态</th>
              <th style={{ width: 240 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {providers.data?.providers?.map((provider: any) => (
              <tr key={provider.id}>
                <td>
                  {provider.name} {provider.is_default && <span className="chip ok">默认</span>}
                </td>
                <td className="muted">{provider.adapter === "mock" ? "内置 Mock" : "OpenAI 兼容"}</td>
                <td className="mono">{provider.model ?? "—"}</td>
                <td className="num">
                  入 {Number(provider.price_input)} / 出 {Number(provider.price_output)}
                </td>
                <td>
                  <span className={`chip ${provider.enabled ? "ok" : "muted"}`}>{provider.enabled ? "启用" : "停用"}</span>
                </td>
                <td>
                  <div className="row">
                    <button className="btn small" onClick={() => test.mutate(provider.id)} disabled={test.isPending}>
                      <Zap size={11} style={{ verticalAlign: -2 }} /> 测试
                    </button>
                    {!provider.is_default && (
                      <button className="btn small" onClick={() => setDefault.mutate(provider.id)}>
                        设为默认
                      </button>
                    )}
                    <button className="btn small" onClick={() => toggleEnabled.mutate(provider)}>
                      {provider.enabled ? "停用" : "启用"}
                    </button>
                    <button className="btn small danger" onClick={() => remove.mutate(provider.id)}>
                      删除
                    </button>
                  </div>
                  {testResult[provider.id] && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{testResult[provider.id]}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          可选适配：{providers.data?.adapters?.map((a: any) => `${a.label}（${a.description}）`).join("；")}
        </div>
      </div>

      <WorkspaceSettings settings={settings.data?.settings} />
      {showAdd && (
        <AddProviderModal
          onClose={() => setShowAdd(false)}
          onDone={() => {
            setShowAdd(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function WorkspaceSettings({ settings }: { settings: any }) {
  const queryClient = useQueryClient();
  const [brandTone, setBrandTone] = useState(settings?.brand_tone ?? "");
  const [aigcPolicy, setAigcPolicy] = useState(settings?.aigc_policy ?? "strict");
  const [dailyBudget, setDailyBudget] = useState(settings?.daily_budget_cny ?? "");
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api("PATCH", "/settings", {
        brandTone,
        aigcPolicy,
        ...(dailyBudget === "" ? {} : { dailyBudgetCny: Number(dailyBudget) }),
      }),
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  return (
    <div className="card">
      <h2>工作空间设置</h2>
      <div className="grid cols-3">
        <div className="field">
          <label>品牌口吻</label>
          <input value={brandTone} onChange={(e) => setBrandTone(e.target.value)} placeholder="例如：真诚、专业、少用感叹号" />
        </div>
        <div className="field">
          <label>AI 声明策略</label>
          <select value={aigcPolicy} onChange={(e) => setAigcPolicy(e.target.value)}>
            <option value="strict">严格：通道不支持平台声明时转人工</option>
            <option value="in_text">宽松：正文声明即可</option>
            <option value="off">不检查（不推荐）</option>
          </select>
        </div>
        <div className="field">
          <label>单日费用预算（元，空为不限）</label>
          <input type="number" min={0} value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} />
        </div>
      </div>
      <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
        保存设置
      </button>
      {saved && <span className="chip ok" style={{ marginLeft: 10 }}>已保存</span>}
    </div>
  );
}

function AddProviderModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [adapter, setAdapter] = useState("openai_compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const [priceOutput, setPriceOutput] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api("POST", "/model-providers", {
        name,
        adapter,
        ...(adapter === "openai_compatible" ? { baseUrl, apiKey, model } : {}),
        priceInput: priceInput ? Number(priceInput) : 0,
        priceOutput: priceOutput ? Number(priceOutput) : 0,
        isDefault,
      }),
    onSuccess: onDone,
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>添加模型供应商</h3>
        <div className="field">
          <label>名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：智谱 GLM / DeepSeek" />
        </div>
        <div className="field">
          <label>适配类型</label>
          <select value={adapter} onChange={(e) => setAdapter(e.target.value)}>
            <option value="openai_compatible">OpenAI 兼容接口（智谱/DeepSeek/通义/Kimi/OpenAI…）</option>
            <option value="mock">内置 Mock（离线演示）</option>
          </select>
        </div>
        {adapter === "openai_compatible" && (
          <>
            <div className="field">
              <label>Base URL</label>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://open.bigmodel.cn/api/paas/v4" />
              <span className="hint">兼容 /chat/completions 的服务地址，不要以斜杠结尾</span>
            </div>
            <div className="field">
              <label>API Key</label>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              <span className="hint">加密保存于服务端，不进入模型上下文与日志</span>
            </div>
            <div className="field">
              <label>模型名</label>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="例如 glm-4-flash / deepseek-chat" />
            </div>
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <label>输入单价（元/百万）</label>
                <input type="number" min={0} step="0.1" value={priceInput} onChange={(e) => setPriceInput(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>输出单价（元/百万）</label>
                <input type="number" min={0} step="0.1" value={priceOutput} onChange={(e) => setPriceOutput(e.target.value)} />
              </div>
            </div>
          </>
        )}
        <label className="row" style={{ gap: 6, marginBottom: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> 设为默认供应商
        </label>
        {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={create.isPending || !name || (adapter === "openai_compatible" && (!baseUrl || !apiKey))}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
