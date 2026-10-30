/**
 * Next.js instrumentation: wires error monitoring for the web process and
 * reports every unhandled server error (pages, actions, route handlers) with
 * its request id.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initMonitoring } = await import("./lib/monitoring");
    await initMonitoring("web");
  }
}

export async function onRequestError(
  err: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routerKind: string; routePath: string; routeType: string },
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportError } = await import("./lib/logger");
  const requestId = request.headers["x-request-id"];
  reportError(err, {
    requestId: Array.isArray(requestId) ? requestId[0] : requestId,
    method: request.method,
    // Route pattern, not the concrete path: paths can carry tokens (e.g. /invite/[token]).
    routePath: context.routePath,
    routeType: context.routeType,
  });
}
