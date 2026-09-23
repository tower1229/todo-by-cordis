/** Refuse paid model runs unless the explicit CLI flag is present. */
export function assertRealModelAuthorization(argv: readonly string[]): void {
  if (!argv.includes("--authorize-real-model"))
    throw new Error(
      "需要显式授权付费模型调用：pnpm accept:stability-baseline --authorize-real-model",
    );
}
