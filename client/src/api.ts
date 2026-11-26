// Thin fetch wrapper. All calculations happen on the server; the client only displays results.
export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  const body = res.headers.get("content-type")?.includes("application/json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status, body?.code);
  return body as T;
}

const HEADERS = { "X-CIM-Request": "1" };

function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method,
    credentials: "same-origin",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => handle<T>(r));
}

export const api = {
  get: <T>(url: string) => fetch(url, { credentials: "same-origin" }).then((r) => handle<T>(r)),
  post: <T>(url: string, body?: unknown) => send<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => send<T>("PUT", url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => send<T>("PATCH", url, body ?? {}),
  del: <T>(url: string) => send<T>("DELETE", url),
  upload: <T>(url: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return fetch(url, { method: "POST", credentials: "same-origin", headers: HEADERS, body: fd }).then((r) => handle<T>(r));
  },
};
