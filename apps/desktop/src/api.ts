const TOKEN_KEY = "aipeople_token";
const BACKEND_KEY = "aipeople_backend";

export const API_BASE: string = localStorage.getItem(BACKEND_KEY) || "http://localhost:8787";

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
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
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
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
    body: form,
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ message: "上传失败" }));
    throw new ApiError(response.status, json.message ?? "上传失败");
  }
  return response.json();
}
