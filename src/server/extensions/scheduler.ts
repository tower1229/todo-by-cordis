import type { ScheduleRegistration } from "../business/contracts.js";

export type ScheduleFireHandler = (
  job: ScheduleRegistration,
) => Promise<void>;

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
      const when = Date.parse(job.at);
      if (Number.isNaN(when)) continue;
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
