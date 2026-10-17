/**
 * dsh-token-badges — host half.
 *
 * Serves per-message token pricing for the client Chat badges:
 *
 *   GET /plugins/token-badges/tokens?sessionId=<id>
 *
 * The handler replays the session through the service token meter
 * (`ctx.tokenMeter.measure`) and returns one token-priced node per surface
 * message, keyed by durable `seq`, so the client can label each user bubble
 * with "the tokens this message contributes to the model request".
 *
 * The turn-level *output* token badge needs no host support: the client
 * conversation definition folds `assistant/message` events, whose `usage`
 * field the session log carries (see subsystems/session.md), exactly like the
 * shipped `turn-tail` node does.
 *
 * @module dsh-token-badges
 */

const ROUTE_PATH = "/plugins/token-badges/tokens";

/** Services this plugin requires at apply time. */
const inject = ["webServer", "tokenMeter", "sessions"];

/** Write a small JSON body and close the response. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

/** Parse the `sessionId` query parameter from the request URL. */
function readSessionId(req) {
  try {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const value = url.searchParams.get("sessionId");
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export const name = "dsh-token-badges";

export function apply(ctx) {
  const webServer = ctx.webServer;
  const tokenMeter = ctx.tokenMeter;
  const sessions = ctx.sessions;

  if (webServer && typeof webServer.register === "function") {
    webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      async handler(req, res) {
        try {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }
          const sessionId = readSessionId(req);
          if (sessionId === null) {
            sendJson(res, 400, { ok: false, error: "missing sessionId" });
            return;
          }
          const session = sessions.get(sessionId);
          if (session === undefined) {
            sendJson(res, 404, { ok: false, error: "session not found" });
            return;
          }
          const measurement = tokenMeter.measure(session);
          const nodes = measurement.nodes.map((node) => ({
            seq: node.seq,
            tokens: node.tokens,
          }));
          sendJson(res, 200, {
            ok: true,
            baseline: measurement.baseline?.kind ?? "estimated",
            totalTokens: measurement.totalTokens,
            surfaceTokens: measurement.surfaceTokens,
            nodes,
          });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: String(error?.message ?? error),
          });
        }
      },
    });
  } else {
    console.warn(
      `[dsh-token-badges] 缺少 webServer 服务，用户消息 token 徽章不可用（其余功能不受影响）`,
    );
  }
}

export { inject };
