import type { ScheduleRegistration } from "../business/contracts.js";
import type { HostClock } from "../host/clock.js";
import { systemClock } from "../host/clock.js";

export type ScheduleFireHandler = (job: ScheduleRegistration) => Promise<void>;

/** Parse ISO with offset/Z, or wall-clock in an IANA timezone. */
export function resolveFireTime(at: string, timezone?: string): number | null {
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
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? "0");
  const minute = Number(match[5] ?? "0");
  const second = Number(match[6] ?? "0");
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const wall = new Date(wallUtc);
  if (
    wall.getUTCFullYear() !== year ||
    wall.getUTCMonth() + 1 !== month ||
    wall.getUTCDate() !== day ||
    wall.getUTCHours() !== hour ||
    wall.getUTCMinutes() !== minute ||
    wall.getUTCSeconds() !== second
  )
    return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const formattedUtc = (ms: number) => {
      const parts = formatter.formatToParts(new Date(ms));
      const value = (type: string) =>
        Number(parts.find((p) => p.type === type)?.value);
      return Date.UTC(
        value("year"),
        value("month") - 1,
        value("day"),
        value("hour"),
        value("minute"),
        value("second"),
      );
    };
    const matches = new Set<number>();
    for (const probe of [wallUtc - 86_400_000, wallUtc, wallUtc + 86_400_000]) {
      const candidate = wallUtc - (formattedUtc(probe) - probe);
      if (formattedUtc(candidate) === wallUtc) matches.add(candidate);
    }
    return matches.size ? Math.min(...matches) : null;
  } catch {
    return null;
  }
}

export class OnlineScheduler {
  private timers = new Map<string, { clear(): void }>();
  private fired = new Set<string>();
  private generation = 0;
  private static readonly maxTimerDelay = 2_147_483_647;

  constructor(private readonly clock: HostClock = systemClock) {}

  cancelAll() {
    this.generation++;
    for (const timer of this.timers.values()) timer.clear();
    this.timers.clear();
    this.fired.clear();
  }

  armedCount() {
    return this.timers.size;
  }

  private armFuture(
    job: ScheduleRegistration,
    when: number,
    fire: ScheduleFireHandler,
  ) {
    const generation = this.generation;
    const delay = Math.min(
      Math.max(0, when - this.clock.now()),
      OnlineScheduler.maxTimerDelay,
    );
    const timer = this.clock.setTimeout(() => {
      if (generation !== this.generation) return;
      this.timers.delete(job.dedupeKey);
      const identity = `${job.dedupeKey}:${job.at}`;
      if (this.fired.has(identity)) return;
      if (this.clock.now() < when) {
        this.armFuture(job, when, fire);
        return;
      }
      this.fired.add(identity);
      return fire(job);
    }, delay);
    this.timers.set(job.dedupeKey, timer);
  }

  arm(
    jobs: ScheduleRegistration[],
    options: {
      fire: ScheduleFireHandler;
      now?: number;
    },
  ) {
    const stillRegistered = new Set(
      jobs.map((job) => `${job.dedupeKey}:${job.at}`),
    );
    this.generation++;
    for (const timer of this.timers.values()) timer.clear();
    this.timers.clear();
    this.fired = new Set(
      [...this.fired].filter((key) => stillRegistered.has(key)),
    );
    const now = options.now ?? this.clock.now();
    for (const job of jobs) {
      const when = resolveFireTime(job.at, job.timezone);
      if (when === null) continue;
      const delay = when - now;
      if (delay <= 0) {
        const identity = `${job.dedupeKey}:${job.at}`;
        if (job.missPolicy === "run-once" && !this.fired.has(identity)) {
          this.fired.add(identity);
          void options.fire(job);
        }
        continue;
      }
      if (!this.fired.has(`${job.dedupeKey}:${job.at}`))
        this.armFuture(job, when, options.fire);
    }
  }
}
