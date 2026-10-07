import { pool } from "@/lib/database";
import { DataError } from "./validation";

type Release = () => void;
type Waiter = {
  site: string;
  deadline: number;
  resolve: (release: Release) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** Process-local fairness; PostgreSQL remains the cross-process authority. */
export class WriteAdmission {
  private active = 0;
  private readonly activeSites = new Set<string>();
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly limits: {
      maxActive: number;
      maxQueued: number;
      maxQueuedPerSite: number;
      queueTimeoutMs: number;
    },
  ) {
    if (
      !Object.values(limits).every(Number.isSafeInteger) ||
      limits.maxActive < 1 ||
      limits.maxQueued < 0 ||
      limits.maxQueuedPerSite < 0 ||
      limits.queueTimeoutMs < 1
    )
      throw new Error("Invalid write admission limits.");
  }

  get state() {
    return {
      active: this.active,
      queued: this.queue.length,
      activeSites: this.activeSites.size,
    };
  }

  async run<T>(
    site: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(site, signal);
    try {
      // A signal can abort after admission but before this continuation runs.
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  private busy() {
    return new DataError(
      503,
      "Site writes are busy. Try again shortly.",
      "UNAVAILABLE",
    );
  }

  private acquire(site: string, signal?: AbortSignal): Promise<Release> {
    signal?.throwIfAborted();
    if (this.active < this.limits.maxActive && !this.activeSites.has(site))
      return Promise.resolve(this.lease(site));
    if (
      this.queue.length >= this.limits.maxQueued ||
      this.queue.filter((waiter) => waiter.site === site).length >=
        this.limits.maxQueuedPerSite
    )
      return Promise.reject(this.busy());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        site,
        deadline: performance.now() + this.limits.queueTimeoutMs,
        resolve,
        reject,
        signal,
      };
      this.queue.push(waiter);
      waiter.timer = setTimeout(
        () => this.rejectQueued(waiter, this.busy()),
        this.limits.queueTimeoutMs,
      );
      waiter.timer.unref?.();
      if (signal) {
        waiter.onAbort = () => this.rejectQueued(waiter, signal.reason);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  private clean(waiter: Waiter) {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.onAbort)
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
  }

  private rejectQueued(waiter: Waiter, error: unknown) {
    const index = this.queue.indexOf(waiter);
    if (index === -1) return;
    this.queue.splice(index, 1);
    this.clean(waiter);
    waiter.reject(error);
  }

  private lease(site: string): Release {
    this.active++;
    this.activeSites.add(site);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.activeSites.delete(site);
      this.pump();
    };
  }

  private pump() {
    while (this.active < this.limits.maxActive) {
      // FIFO among eligible sites: a busy site's backlog must not prevent
      // another site from using an available global slot.
      const index = this.queue.findIndex(
        (waiter) => !this.activeSites.has(waiter.site),
      );
      if (index === -1) return;
      const [waiter] = this.queue.splice(index, 1);
      this.clean(waiter);
      // Promise continuations can run before an overdue timer callback. Check
      // the monotonic deadline here too, so expired work is never admitted.
      if (performance.now() >= waiter.deadline) {
        waiter.reject(this.busy());
        continue;
      }
      waiter.resolve(this.lease(waiter.site));
    }
  }
}

// At most one site-data writer per site, with at most half this process's
// database pool admitted globally. Other request paths still share the pool:
// this bounds site-data writes rather than promising reserved connections.
export const siteDataWriteAdmission = new WriteAdmission({
  maxActive: Math.max(1, Math.floor(pool.options.max / 2)),
  maxQueued: 256,
  maxQueuedPerSite: 64,
  queueTimeoutMs: 10000,
});
