import { proxyToWorker } from "../_proxy";

export async function GET(request) {
  return proxyToWorker(request, "/api/state");
}
