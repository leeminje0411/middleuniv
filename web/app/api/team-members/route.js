import { proxyToWorker } from "../_proxy";

export async function GET(request) {
  return proxyToWorker(request, "/api/team-members");
}

export async function POST(request) {
  return proxyToWorker(request, "/api/team-members");
}

export async function DELETE(request) {
  return proxyToWorker(request, "/api/team-members");
}
