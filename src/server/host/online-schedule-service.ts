import type { BaseServiceSummary } from "../../shared/contracts.js";
import type { ScheduleRegistration } from "../business/contracts.js";
import {
  OnlineScheduler,
  type ScheduleFireHandler,
} from "../extensions/scheduler.js";
import type { HostClock } from "./clock.js";

export const ONLINE_SCHEDULER_SERVICE_ID = "host:online-scheduler" as const;

export const onlineScheduleServiceLifecycles = [
  "created",
  "bound",
  "stopped",
  "released",
] as const;
export type OnlineScheduleServiceLifecycle =
  (typeof onlineScheduleServiceLifecycles)[number];

/**
 * Host-managed online schedule engine. Distinct from business members:
 * ordinary self-iteration may declare schedule.register rules, but cannot
 * create, upgrade, or replace this runtime service.
 */
export class OnlineScheduleService {
  readonly id = ONLINE_SCHEDULER_SERVICE_ID;
  private phase: OnlineScheduleServiceLifecycle = "created";
  private readonly scheduler: OnlineScheduler;

  constructor(private readonly clock: HostClock) {
    this.scheduler = new OnlineScheduler(clock);
  }

  lifecycle() {
    return this.phase;
  }

  summary(): BaseServiceSummary {
    return {
      id: this.id,
      kind: "host-base",
      interfaceId: "schedule.runtime",
      status:
        this.phase === "bound"
          ? "active"
          : this.phase === "released"
            ? "released"
            : "stopped",
    };
  }

  armedCount() {
    return this.scheduler.armedCount();
  }

  bind(
    jobs: ScheduleRegistration[],
    options: { fire: ScheduleFireHandler },
  ) {
    if (this.phase === "released")
      throw new Error("online schedule service already released");
    this.scheduler.arm(jobs, {
      fire: options.fire,
      now: this.clock.now(),
    });
    this.phase = "bound";
  }

  stop() {
    if (this.phase === "released") return;
    this.scheduler.cancelAll();
    this.phase = "stopped";
  }

  release() {
    this.scheduler.cancelAll();
    this.phase = "released";
  }
}
