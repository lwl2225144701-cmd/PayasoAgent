// Module: Tool Argument Validation — the declared Tool schema is a contract,
// not a suggestion.
//
// Why this module exists (v1.8):
// The Runtime parsed tool arguments as JSON and handed them to the tool, but
// never checked them against the tool's own JSON Schema. A model that invented
// `{"command":"npm test","timeout":120}` had the unknown `timeout` silently
// dropped, believed it had extended the timeout, and could never learn
// otherwise. Silent dropping is the worst outcome: the model's intent is lost
// AND no feedback is produced. This module turns every contract violation into
// an explicit, actionable, model-visible error.
//
// Scope: the JSON Schema subset the tool registry actually uses —
// object/properties/required/additionalProperties, array/items, scalar types,
// and enum. It is intentionally small, pure, and dependency-free; an unknown
// schema keyword is ignored rather than treated as a failure (fail-open for the
// *schema*, fail-closed for the *arguments*).

export type ToolArgumentIssueKind = 'unknown' | 'missing' | 'type' | 'enum';

export interface ToolArgumentIssue {
  kind: ToolArgumentIssueKind;
  /** Dot path of the offending argument, e.g. `path` or `edits[0].oldText`. */
  key: string;
  /** What the schema expects (type name or enum values). */
  expected?: string;
  /** What was received, for type mismatches. */
  received?: string;
  /** Accepted parameter names, for unknown-key issues at the top level. */
  accepted?: string[];
}

export interface ToolArgumentValidation {
  ok: boolean;
  issues: ToolArgumentIssue[];
}

type Schema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      // Unknown schema type: never block a call on a validator limitation.
      return true;
  }
}

function expectedTypeLabel(type: unknown): string | undefined {
  if (typeof type === 'string') return type;
  if (Array.isArray(type) && type.every((item) => typeof item === 'string')) {
    return (type as string[]).join(' | ');
  }
  return undefined;
}

function validateValue(
  schema: Schema,
  value: unknown,
  keyPath: string,
  issues: ToolArgumentIssue[],
): void {
  const typeLabel = expectedTypeLabel(schema.type);
  const acceptedTypes = Array.isArray(schema.type)
    ? (schema.type as string[])
    : typeof schema.type === 'string'
      ? [schema.type]
      : [];
  if (acceptedTypes.length > 0 && !acceptedTypes.some((type) => matchesType(value, type))) {
    issues.push({
      kind: 'type',
      key: keyPath,
      expected: typeLabel,
      received: typeName(value),
    });
    return;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((candidate) => candidate === value)) {
      issues.push({
        kind: 'enum',
        key: keyPath,
        expected: allowed.map((item) => JSON.stringify(item)).join(', '),
      });
      return;
    }
  }

  if (Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) => {
      validateValue(schema.items as Schema, item, `${keyPath}[${index}]`, issues);
    });
  }

  if (isRecord(value) && isRecord(schema.properties)) {
    validateObject(schema, value, keyPath, issues);
  }
}

function validateObject(
  schema: Schema,
  args: Record<string, unknown>,
  keyPath: string,
  issues: ToolArgumentIssue[],
): void {
  const properties = isRecord(schema.properties)
    ? (schema.properties as Record<string, Schema>)
    : {};
  const declared = Object.keys(properties);
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const allowsAdditional = schema.additionalProperties === true;

  for (const name of required) {
    if (!(name in args) || args[name] === undefined) {
      issues.push({
        kind: 'missing',
        key: keyPath ? `${keyPath}.${name}` : name,
        expected: expectedTypeLabel(properties[name]?.type) ?? 'required',
      });
    }
  }

  if (!allowsAdditional) {
    for (const name of Object.keys(args)) {
      if (name in properties) continue;
      if (args[name] === undefined) continue; // omitted optional: not a violation
      issues.push({
        kind: 'unknown',
        key: keyPath ? `${keyPath}.${name}` : name,
        accepted: declared,
      });
    }
  }

  for (const [name, child] of Object.entries(properties)) {
    if (!(name in args) || args[name] === undefined) continue;
    validateValue(child, args[name], keyPath ? `${keyPath}.${name}` : name, issues);
  }
}

/**
 * Validate one parsed tool call against the tool's declared JSON Schema.
 * Returns every violation (not just the first) so the model can fix them in a
 * single retry instead of discovering them one at a time.
 */
export function validateToolArguments(
  parameters: unknown,
  args: Record<string, unknown>,
): ToolArgumentValidation {
  if (!isRecord(parameters)) return { ok: true, issues: [] };
  const issues: ToolArgumentIssue[] = [];
  validateObject(parameters, args, '', issues);
  return { ok: issues.length === 0, issues };
}

/** Model-facing, stable rendering of the issues. Never includes host paths. */
export function formatToolArgumentIssues(toolName: string, issues: ToolArgumentIssue[]): string {
  const lines = issues.map((issue) => {
    if (issue.kind === 'unknown') {
      const accepted =
        issue.accepted && issue.accepted.length > 0
          ? `accepted parameters: ${issue.accepted.join(', ')}`
          : 'this tool declares no parameters';
      return `- unknown parameter "${issue.key}" (${accepted})`;
    }
    if (issue.kind === 'missing') {
      return `- missing required parameter "${issue.key}"`;
    }
    if (issue.kind === 'enum') {
      return `- parameter "${issue.key}" must be one of: ${issue.expected}`;
    }
    return `- parameter "${issue.key}" must be ${issue.expected}, received ${issue.received}`;
  });
  return [
    `Tool "${toolName}" arguments are invalid:`,
    ...lines,
    'Retry this tool call with corrected arguments. Only declared parameters are accepted.',
  ].join('\n');
}
