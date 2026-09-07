import { useCallback, useEffect, useRef, useState } from "react";
import {
  isAssistantWorking,
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
      const result = await api<AssistantSnapshot>("/assistant");
      if (request !== sequence.current) return;
      setSnapshot(result);
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
    // Polling observes host state only, and continues when the panel is closed.
    const timer = setInterval(() => {
      void observe();
    }, 1500);
    return () => clearInterval(timer);
  }, [working, error, observe]);
  useEffect(() => {
    const run = snapshot?.run;
    if (run?.status === "succeeded" && completed.current !== run.id) {
      completed.current = run.id;
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
      setSnapshot(result);
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
