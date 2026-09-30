export const SHARED_INTERNAL_TIMEOUT_MS = 40_000;
export const SHARED_QUOTA_BUDGET_MS = 5_000;

export class BudgetExpired extends Error {
  constructor(
    readonly kind: "request_deadline" | "quota_timeout" | "timeout",
    readonly reason = "expired",
  ) {
    super(kind);
  }
}

/** Monotonic deadline. Checks after awaits also reject late, non-cooperative mocks. */
export class GenerationBudget {
  readonly controller = new AbortController();
  readonly end: number;
  constructor(
    duration = SHARED_INTERNAL_TIMEOUT_MS,
    readonly now = () => performance.now(),
    readonly kind: BudgetExpired["kind"] = "request_deadline",
    readonly parent?: GenerationBudget,
  ) {
    this.end = now() + duration;
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  remaining(): number {
    return Math.min(
      this.end - this.now(),
      this.parent?.remaining() ?? Infinity,
    );
  }
  check(required = 0) {
    this.parent?.check();
    if (this.signal.aborted || this.remaining() <= 0) {
      this.controller.abort();
      throw new BudgetExpired(this.kind);
    }
    if (this.remaining() < required) {
      throw new BudgetExpired("request_deadline", "insufficient_time");
    }
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onParent: (() => void) | undefined;
    const expiration = new Promise<never>((_, reject) => {
      const expire = () => {
        this.controller.abort();
        reject(
          new BudgetExpired(
            this.parent?.signal.aborted ? "request_deadline" : this.kind,
          ),
        );
      };
      timer = setTimeout(expire, Math.max(0, this.remaining()));
      if (this.parent) {
        onParent = expire;
        this.parent.signal.addEventListener("abort", onParent, { once: true });
      }
    });
    try {
      const result = await Promise.race([work(), expiration]);
      this.check();
      return result;
    } finally {
      clearTimeout(timer);
      if (onParent) this.parent!.signal.removeEventListener("abort", onParent);
    }
  }
}
