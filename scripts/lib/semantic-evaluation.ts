import {
  ModelTransportError,
  type ModelReply,
  type ModelRequest,
} from "../../src/evolution/driver.js";
import { replyProblems } from "../../src/evolution/model-protocol.js";

export function scoreSemanticReply(
  request: ModelRequest,
  response: ModelReply,
  expectedModel: string,
  grade: (text: string) => boolean,
) {
  const problems = replyProblems(request, response);
  if (response.transport?.actualModel !== expectedModel)
    problems.push("响应模型身份不符或缺失");
  if (response.transport?.finishReason !== "stop")
    problems.push("响应未正常完成");
  if (problems.length)
    return { passed: false, category: "protocol" as const, problems };
  try {
    return grade(response.text)
      ? { passed: true, category: "passed" as const, problems: [] }
      : {
          passed: false,
          category: "semantics" as const,
          problems: ["固定业务语义评分未通过"],
        };
  } catch (error) {
    return {
      passed: false,
      category: "semantics" as const,
      problems: [error instanceof Error ? error.message : "宿主语义校验失败"],
    };
  }
}

/** The thrown exception contains the final transport failure, beyond the last progress callback. */
export function semanticFailure(
  error: unknown,
  progress?: ModelReply["transport"],
) {
  return {
    passed: false,
    category:
      error instanceof ModelTransportError
        ? ("transport" as const)
        : ("evaluator" as const),
    error: error instanceof Error ? error.message : String(error),
    transport:
      error instanceof ModelTransportError ? error.transport : progress,
  };
}
