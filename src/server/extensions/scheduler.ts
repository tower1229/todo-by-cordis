import type { ScheduleRegistration } from "../business/contracts.js";

export type ScheduleFireHandler = (
  job: ScheduleRegistration,
) => Promise<void>;

/** Parse ISO with offset/Z, or wall-clock in an IANA timezone. */
export function resolveFireTime(
  at: string,
  timezone?: string,
): number | null {
  const trimmed = at.trim();
  if (!trimmed) return null;
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : ms;
  }
  if (!timezone) {
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : ms;
  }
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!match) {
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : ms;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? "0");
  const minute = Number(match[5] ?? "0");
  const second = Number(match[6] ?? "0");
  try {
    const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(probe);
    const value = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour"),
      value("minute"),
      value("second"),
    );
    const offset = asUtc - probe.getTime();
    return probe.getTime() - offset;
  } catch {
    return null;
  }
}

export class OnlineScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private fired = new Set<string>();

  cancelAll() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.fired.clear();
  }

  armedCount() {
    return this.timers.size;
  }

  arm(
    jobs: ScheduleRegistration[],
    options: { fire: ScheduleFireHandler; now?: number },
  ) {
    this.cancelAll();
    const now = options.now ?? Date.now();
    for (const job of jobs) {
      const when = resolveFireTime(job.at, job.timezone);
      if (when === null) continue;
      const delay = when - now;
      if (delay <= 0) {
        if (job.missPolicy === "run-once" && !this.fired.has(job.dedupeKey)) {
          this.fired.add(job.dedupeKey);
          void options.fire(job);
        }
        continue;
      }
      const timer = setTimeout(() => {
        this.timers.delete(job.dedupeKey);
        if (this.fired.has(job.dedupeKey)) return;
        this.fired.add(job.dedupeKey);
        void options.fire(job);
      }, delay);
      this.timers.set(job.dedupeKey, timer);
    }
  }
}
