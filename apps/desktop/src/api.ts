const TOKEN_KEY = "aipeople_token";
const BACKEND_KEY = "aipeople_backend";

interface BackendBridge {
  getBackendPort?: () => Promise<{ port: number; mode: string; sessionToken?: string }>;
  onBackendFailed?: (callback: (message: string) => void) => () => void;
  isDesktop?: boolean;
  version?: string;
}

const bridge = (window as unknown as { aipeople?: BackendBridge }).aipeople;

let apiBase: string | null = null;
let sessionToken = '';

/** 解析后台地址：独立模式用内嵌端口；浏览器/开发模式用本地存储或默认 8787。 */
export async function initApiBase(): Promise<string> {
  if (apiBase) return apiBase;
  if (bridge?.getBackendPort) {
    const info = await bridge.getBackendPort();
    if (info?.port) {
      sessionToken = info.sessionToken ?? '';
      apiBase = `http://127.0.0.1:${info.port}`;
      return apiBase;
    }
  }
  apiBase = localStorage.getItem(BACKEND_KEY) || "http://localhost:8787";
  return apiBase;
}

export function currentApiBase(): string {
  return apiBase ?? localStorage.getItem(BACKEND_KEY) ?? "http://localhost:8787";
}

/** 后台启动失败订阅（独立模式）。 */
export function onBackendFailed(callback: (message: string) => void): () => void {
  return bridge?.onBackendFailed ? bridge.onBackendFailed(callback) : () => {};
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  await initApiBase();
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
      ...(sessionToken ? { 'x-easycontrol-session': sessionToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ message: `请求失败（${response.status}）` }));
    throw new ApiError(response.status, json.message ?? `请求失败（${response.status}）`);
  }
  return (await response.json()) as T;
}

/** multipart 文件上传 */
export async function uploadFile(path: string, file: File): Promise<any> {
  await initApiBase();
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}), ...(sessionToken ? { 'x-easycontrol-session':sessionToken } : {}) },
    body: form,
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ message: "上传失败" }));
    throw new ApiError(response.status, json.message ?? "上传失败");
  }
  return response.json();
}

/**
 * 个人模式免登录：优先复用本地令牌（校验其有效性），失败则自动以本地账号连接后台。
 */
export async function ensureLocalLogin(): Promise<void> {
  const existing = getToken();
  if (existing) {
    try {
      await api("GET", "/me");
      return;
    } catch {
      logout();
    }
  }
  const result = await api<{ token: string }>("POST", "/auth/local");
  if (!result.token) throw new Error("后台未返回访问令牌");
  setToken(result.token);
}
