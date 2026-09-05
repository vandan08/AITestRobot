import { readToken } from "./auth";

export interface ApiError {
  error?: string;
  errors?: Record<string, string>;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error("Request failed"), {
      status: response.status,
      body: body as ApiError,
    });
  }
  return body as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  listUsers: (params: URLSearchParams) =>
    request<{
      users: Array<Record<string, unknown>>;
      total: number;
      page: number;
      totalPages: number;
    }>(`/api/users?${params.toString()}`),
  getUser: (id: string) => request<Record<string, unknown>>(`/api/users/${id}`),
  saveUser: (id: string, payload: unknown) =>
    request<Record<string, unknown>>(`/api/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
};
