type DiagnosticEmitter = (
  event: string,
  fields: Record<string, unknown>,
) => void;

function diagnostic(event: string, fields: Record<string, unknown>) {
  console.log(`[SharedAiChunkStore] ${JSON.stringify({ event, ...fields })}`);
}

export class SharedAiChunkStore {
  constructor(
    readonly env = (key: string) => Deno.env.get(key),
    readonly fetcher = fetch,
    readonly emit: DiagnosticEmitter = diagnostic,
  ) {}

  async rpc<T>(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const started = performance.now();
    const url = this.env("SUPABASE_URL");
    const key = this.env("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw Error("store_unavailable");
    const fields = {
      rpc: name,
      stage: name.includes("late_result") || name.includes("primary")
        ? "database_rpc_save"
        : "database_rpc",
    };
    let response: Response;
    try {
      response = await this.fetcher(`${url}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.any([
          AbortSignal.timeout(5000),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch (error) {
      this.emit("database_rpc_failed", {
        ...fields,
        error_class: error instanceof DOMException &&
            error.name === "TimeoutError"
          ? "timeout_or_abort"
          : "network_error",
        duration_ms: Math.round(performance.now() - started),
      });
      throw Error("store_unavailable");
    }
    if (!response.ok) {
      this.emit("database_rpc_failed", {
        ...fields,
        http_status: response.status,
        error_class: "database_http_error",
        duration_ms: Math.round(performance.now() - started),
      });
      throw Error("store_unavailable");
    }
    if (response.status === 204) return undefined as T;
    try {
      return await response.json();
    } catch {
      this.emit("database_rpc_failed", {
        ...fields,
        http_status: response.status,
        error_class: "database_response_parse_failure",
        duration_ms: Math.round(performance.now() - started),
      });
      throw Error("store_unavailable");
    }
  }
}
