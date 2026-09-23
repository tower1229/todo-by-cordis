export type TimerHandle = {
  clear(): void;
};

export type HostClock = {
  now(): number;
  setTimeout(
    handler: () => void | Promise<void>,
    delayMs: number,
  ): TimerHandle;
};

export type ControllableClock = HostClock & {
  advance(ms: number): Promise<void>;
};

const controllableBrand = Symbol("controllableClock");

type BrandedControllable = ControllableClock & {
  readonly [controllableBrand]: true;
};

export const systemClock: HostClock = {
  now() {
    return Date.now();
  },
  setTimeout(handler, delayMs) {
    const id = setTimeout(() => {
      void handler();
    }, delayMs);
    return { clear: () => clearTimeout(id) };
  },
};

export function isControllableClock(
  clock: HostClock,
): clock is ControllableClock {
  return (
    typeof clock === "object" &&
    clock !== null &&
    controllableBrand in clock &&
    (clock as BrandedControllable)[controllableBrand] === true
  );
}

/** Host-test clock: advances virtual time and due timers together. */
export function createControllableClock(startMs = 0): ControllableClock {
  let current = startMs;
  let seq = 0;
  const timers = new Map<
    number,
    {
      when: number;
      handler: () => void | Promise<void>;
      cleared: boolean;
    }
  >();
  const pending: Promise<unknown>[] = [];

  const track = (result: void | Promise<void>) => {
    if (result && typeof (result as Promise<void>).then === "function")
      pending.push(result as Promise<void>);
  };

  const drain = async () => {
    while (pending.length) {
      const batch = pending.splice(0);
      await Promise.all(batch);
    }
  };

  const clock: BrandedControllable = {
    [controllableBrand]: true,
    now() {
      return current;
    },
    setTimeout(handler, delayMs) {
      const id = ++seq;
      const delay = Math.max(0, delayMs);
      timers.set(id, {
        when: current + delay,
        handler,
        cleared: false,
      });
      return {
        clear() {
          const entry = timers.get(id);
          if (entry) entry.cleared = true;
          timers.delete(id);
        },
      };
    },
    async advance(ms: number) {
      if (ms < 0) throw new Error("clock advance must be non-negative");
      const target = current + ms;
      while (true) {
        let nextId: number | undefined;
        let nextWhen = Number.POSITIVE_INFINITY;
        for (const [id, entry] of timers) {
          if (entry.cleared) continue;
          if (entry.when <= target && entry.when < nextWhen) {
            nextWhen = entry.when;
            nextId = id;
          }
        }
        if (nextId === undefined) {
          current = target;
          await drain();
          return;
        }
        const entry = timers.get(nextId);
        if (!entry || entry.cleared) {
          timers.delete(nextId);
          continue;
        }
        current = entry.when;
        timers.delete(nextId);
        track(entry.handler());
        await drain();
      }
    },
  };
  return clock;
}
