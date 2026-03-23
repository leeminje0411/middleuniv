import { proxyToWorker } from "../../_proxy";

export async function POST(request) {
  return proxyToWorker(request, "/api/everytime/sync-term");
}
