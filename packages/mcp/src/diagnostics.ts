export type DiagnosticCode =
  | "malformed_jsonl"
  | "invalid_wire_record"
  | "invalid_tools_call_request"
  | "duplicate_request_id"
  | "unmatched_response"
  | "unknown_result_type"
  | "incomplete_call";

export interface NormalizationDiagnostic {
  code: DiagnosticCode;
  message: string;
  line?: number;
  sequence?: number;
}
