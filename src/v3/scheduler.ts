import type { Fiber } from "cordis";
import type { SchedulerService } from "./types.js";

function runScheduledTask(
  pluginId: string,
  label: string,
  task: () => Promise<void> | void,
): void {
  try {
    const maybePromise = task();
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch((error) => {
        process.stderr.write(
          `[scheduler:${pluginId}] ${label} task error: ${String(error)}\n`,
        );
      });
    }
  } catch (error) {
    process.stderr.write(
      `[scheduler:${pluginId}] ${label} task error: ${String(error)}\n`,
    );
  }
}

export class SchedulerEngine {
  private readonly countsByPlugin = new Map<string, number>();
  private readonly atDisposersByKey = new Map<string, () => void>();

  private increment(pluginId: string): void {
    this.countsByPlugin.set(pluginId, (this.countsByPlugin.get(pluginId) ?? 0) + 1);
  }

  private decrement(pluginId: string): void {
    const next = (this.countsByPlugin.get(pluginId) ?? 0) - 1;
    if (next <= 0) this.countsByPlugin.delete(pluginId);
    else this.countsByPlugin.set(pluginId, next);
  }

  activeTimerCount(pluginId: string): number {
    return this.countsByPlugin.get(pluginId) ?? 0;
  }

  createScopedScheduler(pluginId: string, fiber: Fiber): SchedulerService {
    return {
      every: (intervalMs, task) => {
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
          throw new Error(
            `Scheduler every() requires positive finite intervalMs, received ${intervalMs}`,
          );
        }

        let stopped = false;
        const disposeEffect = fiber.effect(() => {
          this.increment(pluginId);
          const timer = setInterval(() => {
            if (!stopped) runScheduledTask(pluginId, "every", task);
          }, intervalMs);

          return () => {
            if (stopped) return;
            stopped = true;
            clearInterval(timer);
            this.decrement(pluginId);
          };
        }, `schedule.every(${intervalMs}ms)`);

        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          void disposeEffect();
        };
      },

      at: (timestampIso, key, task) => {
        const targetMs = Date.parse(timestampIso);
        if (!Number.isFinite(targetMs)) {
          throw new Error(`Scheduler at() received invalid timestamp: ${timestampIso}`);
        }
        const scopedKey = `${pluginId}::${key}`;
        this.atDisposersByKey.get(scopedKey)?.();

        let active = true;
        const disposeEffect = fiber.effect(() => {
          this.increment(pluginId);
          const delay = Math.max(0, targetMs - Date.now());
          const cleanup = () => {
            if (!active) return;
            active = false;
            clearTimeout(timer);
            if (this.atDisposersByKey.get(scopedKey) === manualDispose) {
              this.atDisposersByKey.delete(scopedKey);
            }
            this.decrement(pluginId);
          };

          const timer = setTimeout(() => {
            if (!active) return;
            cleanup();
            runScheduledTask(pluginId, `at(${key})`, task);
          }, delay);

          return cleanup;
        }, `schedule.at(${key})`);

        let disposed = false;
        const manualDispose = () => {
          if (disposed) return;
          disposed = true;
          void disposeEffect();
        };

        this.atDisposersByKey.set(scopedKey, manualDispose);
        return manualDispose;
      },
    };
  }
}
