export type AccountDeletionJson = (status: number, body: Record<string, unknown>) => Response;

export function withAccountDeletionHttp(
  handle: (request: Request, json: AccountDeletionJson) => Response | Promise<Response>,
  readAllowedOrigins: () => string | undefined,
) {
  return (request: Request) => {
    const origin = request.headers.get("Origin");
    const allowed =
      origin &&
      origin !== "null" &&
      readAllowedOrigins()
        ?.split(",")
        .some((value) => value.trim() === origin);
    const headers = new Headers({ "Cache-Control": "private, no-store", Vary: "Origin" });
    if (allowed) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "authorization, x-client-info, apikey, content-type",
      );
    }
    const json: AccountDeletionJson = (status, body) => {
      const jsonHeaders = new Headers(headers);
      jsonHeaders.set("Content-Type", "application/json");
      return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
    };

    if (origin !== null && !allowed) return json(403, { code: "origin_not_allowed" });
    if (request.method === "OPTIONS") {
      if (!allowed) return json(403, { code: "origin_not_allowed" });
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") return json(404, { code: "not_found" });
    return handle(request, json);
  };
}
