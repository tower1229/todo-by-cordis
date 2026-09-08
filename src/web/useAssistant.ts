import { useCallback, useEffect, useRef, useState } from "react";
import {
  isAssistantWorking,
  type AssistantEvent,
  type AssistantSnapshot,
  type AssistantCommand,
} from "../shared/assistant.js";
import { api, errorMessage, sendOperation } from "./api.js";

type CommandInput = AssistantCommand extends infer C
  ? C extends AssistantCommand
    ? Omit<C, "operationId">
    : never
  : never;
export function useAssistant(onCompleted: () => Promise<void>) {
  const [snapshot, setSnapshot] = useState<AssistantSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(
    () => localStorage.getItem("assistant-draft") ?? "",
  );
  const sequence = useRef(0);
  const locked = useRef(false);
  const observing = useRef(false);
  const completed = useRef<string | null>(null);
  const eventCursor = useRef(0);
  const events = useRef<AssistantEvent[]>([]);
  const runId = useRef<string | undefined>(undefined);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  useEffect(() => {
    localStorage.setItem("assistant-draft", draft);
  }, [draft]);
  const observe = useCallback(async () => {
    if (locked.current || observing.current) return;
    observing.current = true;
    const request = ++sequence.current;
    try {
      const id = runId.current;
      const query = id
        ? `?runId=${encodeURIComponent(id)}&after=${eventCursor.current}`
        : "";
      const result = await api<AssistantSnapshot>(`/assistant${query}`);
      if (request !== sequence.current) return;
      if (result.run?.id && result.run.id !== runId.current) {
        runId.current = result.run.id;
        events.current = result.events ?? [];
        eventCursor.current = result.eventCursor ?? 0;
      } else if (result.events?.length) {
        const seen = new Set(events.current.map((e) => e.sequence));
        for (const event of result.events)
          if (!seen.has(event.sequence)) events.current.push(event);
        eventCursor.current =
          result.eventCursor ??
          events.current.at(-1)?.sequence ??
          eventCursor.current;
      } else if (result.run) runId.current = result.run.id;
      else runId.current = undefined;
      setSnapshot({
        ...result,
        events: [...events.current],
        eventCursor: eventCursor.current,
      });
      setError("");
    } catch (error) {
      if (request === sequence.current) setError(errorMessage(error));
    } finally {
      observing.current = false;
    }
  }, []);
  useEffect(() => {
    void observe();
    return () => {
      sequence.current++;
    };
  }, [observe]);
  const working = isAssistantWorking(snapshot?.run);
  useEffect(() => {
    if (!working && !error) return;
    const timer = setInterval(() => {
      void observe();
    }, 1500);
    return () => clearInterval(timer);
  }, [working, error, observe]);
  useEffect(() => {
    const run = snapshot?.run;
    if (
      (run?.status === "succeeded" || run?.status === "awaiting-apply") &&
      completed.current !== `${run.id}:${run.status}`
    ) {
      completed.current = `${run.id}:${run.status}`;
      void onCompletedRef.current();
    }
  }, [snapshot]);
  async function command(input: CommandInput) {
    if (locked.current) return false;
    locked.current = true;
    sequence.current++;
    setBusy(true);
    setError("");
    try {
      const result = await sendOperation<AssistantSnapshot>(
        "/assistant/commands",
        input,
      );
      sequence.current++;
      if (result.run?.id) {
        if (result.run.id !== runId.current || input.type === "start") {
          events.current = result.events ?? [];
          eventCursor.current = result.eventCursor ?? 0;
        }
        runId.current = result.run.id;
      }
      setSnapshot({
        ...result,
        events: [...events.current],
        eventCursor: eventCursor.current,
      });
      return true;
    } catch (error) {
      setError(errorMessage(error));
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return { snapshot, working, busy, error, draft, setDraft, observe, command };
}
export type AssistantController = ReturnType<typeof useAssistant>;
