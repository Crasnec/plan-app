export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(data.error || "요청을 처리하지 못했습니다."),
      { status: response.status },
    );
  return data as T;
}
export interface Me {
  owner: boolean;
  demo: boolean;
  loginReady: boolean;
  pushKey: string;
}
