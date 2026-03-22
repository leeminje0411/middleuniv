function getWorkerBaseUrl() {
  return process.env.WORKER_BASE_URL || "http://localhost:4000";
}

export async function proxyToWorker(request, path) {
  const workerUrl = new URL(path, getWorkerBaseUrl());

  const headers = new Headers(request.headers);
  headers.delete("host");

  const init = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    cache: "no-store"
  };

  try {
    const res = await fetch(workerUrl, init);
    const body = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") || "application/octet-stream";

    return new Response(body, {
      status: res.status,
      headers: {
        "content-type": contentType,
        "cache-control": "no-store"
      }
    });
  } catch (err) {
    const message = err && err.message ? String(err.message) : "fetch failed";
    const payload = {
      ok: false,
      message: "Worker 서버(http://localhost:4000)에 연결할 수 없습니다. 먼저 루트에서 `node server.js`를 실행해 두세요.",
      detail: message,
      workerBaseUrl: getWorkerBaseUrl(),
      path
    };

    return new Response(JSON.stringify(payload), {
      status: 502,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
}
