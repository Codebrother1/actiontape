export class ContractParseError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string | readonly string[]) {
    const list = typeof issues === "string" ? [issues] : issues;
    super(`invalid contract: ${list.join("; ")}`);
    this.name = "ContractParseError";
    this.issues = list;
  }
}
