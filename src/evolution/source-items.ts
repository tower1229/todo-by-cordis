import { hash } from "../release/storage.js";
import {
  clarificationChoiceQuestion,
  type ClarificationChoice,
} from "../shared/clarification-choice.js";

type Source = { id: string; text: string };
export type SourceItem = {
  id: string;
  sourceRevision: string;
  ordinal: number;
  /** Offsets use JavaScript string indices, so source.slice(start, end) is exact. */
  start: number;
  end: number;
  text: string;
};
export type AdmissionQuestionTarget = {
  sourceRevision: string;
  sourceQuote: string;
  question: string;
  choice?: ClarificationChoice & { id: string; sourceItem: SourceItem };
};
export type AdmissionChoiceProof = { id: string; hash: string };

/** Punctuation supplies addresses, not a semantic interpretation of the source. */
export function sourceItems(sources: Source[]): SourceItem[] {
  const items: SourceItem[] = [];
  for (const source of sources) {
    const sourceHash = hash(source.text);
    for (const match of source.text.matchAll(/[^，,。；;！？!?\r\n]+/gu)) {
      const text = match[0].trim();
      if (!text) continue;
      const start = match.index + match[0].indexOf(text);
      const end = start + text.length;
      items.push({
        id: "source-item:" + hash({ sourceRevision: source.id, sourceHash, start, end }).slice(0, 24),
        sourceRevision: source.id,
        ordinal: items.length + 1,
        start,
        end,
        text,
      });
    }
  }
  return items;
}

export function sourceChoice(item: SourceItem, choice: ClarificationChoice) {
  return {
    ...choice,
    id: "choice-" + hash({ sourceItemId: item.id, kind: choice.kind }).slice(0, 24),
    sourceItem: item,
  };
}

export function admissionChoiceProof(target: AdmissionQuestionTarget): AdmissionChoiceProof | undefined {
  return target.choice ? { id: target.choice.id, hash: hash(target.choice) } : undefined;
}

/** Review targets come from canonical host projections, never from model-authored identifiers. */
export function assertAdmissionTargets(
  questions: string[],
  targets: AdmissionQuestionTarget[],
  sources: Source[],
) {
  if (questions.length !== targets.length)
    throw new Error("需求澄清与宿主目标数量不一致");
  const catalog = sourceItems(sources);
  for (const [index, target] of targets.entries()) {
    if (questions[index] !== target.question)
      throw new Error("需求澄清与宿主目标顺序不一致");
    if (!target.choice) continue;
    const item = catalog.find((entry) => entry.id === target.choice!.sourceItem?.id);
    if (
      !item ||
      target.choice.kind !== "field-required" ||
      target.sourceRevision !== item.sourceRevision ||
      target.sourceQuote !== item.text ||
      hash(target.choice) !== hash(sourceChoice(item, { kind: target.choice.kind })) ||
      target.question !== clarificationChoiceQuestion(target.choice, item.text, item.ordinal)
    )
      throw new Error("结构化澄清缺少当前宿主来源条目绑定");
  }
}
