/** Normalize common model-generated flowchart labels before Mermaid parses them. */
export function normalizeMermaidChart(chart: string, stackWideChart = false): string {
  const normalizedBreaks = chart
    .replace(/\r\n?/g, '\n')
    .replace(/(?:\\r)?\\n/g, '<br/>')
    .replace(/\\t/g, ' ');
  const responsiveChart = stackWideChart
    ? normalizedBreaks.replace(/^(\s*(?:flowchart|graph)\s+)(?:LR|RL)\b/m, '$1TD')
    : normalizedBreaks;

  return responsiveChart
    .split('\n')
    .map((line) => quoteEdgeLabels(quoteNodeLabels(line)))
    .join('\n');
}

function quoteNodeLabels(line: string): string {
  return line.replace(
    /(^|[^\w-])([A-Za-z_][\w-]*)\[([^\]\r\n]*)\]/g,
    (_match, prefix: string, nodeId: string, label: string) => {
      const trimmed = label.trim();
      if (!trimmed || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
        return `${prefix}${nodeId}[${label}]`;
      }
      return `${prefix}${nodeId}["${trimmed.replace(/"/g, '#quot;')}"]`;
    },
  );
}

/**
 * Mermaid treats parentheses in an unquoted edge label as flowchart syntax.
 * Only inspect arrows outside node shapes and quoted strings, so a label that
 * happens to contain `-->|...|` stays untouched.
 */
function quoteEdgeLabels(line: string): string {
  let quoted = false;
  const shapeClosers: string[] = [];
  let out = '';
  for (let i = 0; i < line.length; ) {
    const char = line[i];
    if (char === '"' && line[i - 1] !== '\\') quoted = !quoted;
    if (!quoted) {
      if (char === '[') shapeClosers.push(']');
      else if (char === '(') shapeClosers.push(')');
      else if (char === '{') shapeClosers.push('}');
      else if (char === shapeClosers[shapeClosers.length - 1]) shapeClosers.pop();
    }

    if (!quoted && shapeClosers.length === 0) {
      const arrow = /^(?:--+>|==+>|-\.->)\|/.exec(line.slice(i));
      if (arrow) {
        const start = i + arrow[0].length;
        let end = start;
        let labelQuoted = false;
        for (; end < line.length; end++) {
          if (line[end] === '"' && line[end - 1] !== '\\') labelQuoted = !labelQuoted;
          if (line[end] === '|' && !labelQuoted && line[end - 1] !== '\\') break;
        }
        if (end < line.length) {
          const label = line.slice(start, end);
          const trimmed = label.trim();
          const safeLabel =
            trimmed && !(trimmed.startsWith('"') && trimmed.endsWith('"'))
              ? `"${label.replace(/"/g, '#quot;')}"`
              : label;
          out += `${arrow[0]}${safeLabel}|`;
          i = end + 1;
          continue;
        }
      }
    }
    out += char;
    i++;
  }
  return out;
}
