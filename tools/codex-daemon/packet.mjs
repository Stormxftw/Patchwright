const REQUIRED_FIELDS = ['goal', 'scope', 'acceptanceCriteria', 'validationCommands'];

const HEADING_ALIASES = new Map([
  ['goal', 'goal'],
  ['purpose', 'goal'],
  ['objective', 'goal'],
  ['scope', 'scope'],
  ['acceptance criteria', 'acceptanceCriteria'],
  ['acceptance', 'acceptanceCriteria'],
  ['done when', 'acceptanceCriteria'],
  ['validation', 'validationCommands'],
  ['validation commands', 'validationCommands'],
  ['verification', 'validationCommands'],
  ['verification commands', 'validationCommands'],
  ['allowed paths', 'allowedPaths'],
  ['allowed path', 'allowedPaths'],
  ['suspect files', 'suspectFiles'],
  ['suspect file', 'suspectFiles'],
  ['constraints', 'constraints'],
  ['notes', 'constraints']
]);

function normalizeHeading(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[:#]+$/g, '')
    .replace(/\s+/g, ' ');
}

function normalizeLine(value) {
  return String(value ?? '')
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .trim();
}

function splitList(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean)
    .filter((line) => !/^```/.test(line));
}

function compactText(value) {
  return splitList(value).join('\n');
}

function sectionMap(body) {
  const sections = new Map();
  let currentKey = null;
  let current = [];

  for (const line of String(body ?? '').split(/\r?\n/)) {
    const match = line.match(/^#{2,6}\s+(.+?)\s*$/);
    if (match) {
      if (currentKey) {
        sections.set(currentKey, [...(sections.get(currentKey) ?? []), current.join('\n').trim()].filter(Boolean).join('\n'));
      }
      currentKey = HEADING_ALIASES.get(normalizeHeading(match[1])) ?? null;
      current = [];
      continue;
    }

    if (currentKey) {
      current.push(line);
    }
  }

  if (currentKey) {
    sections.set(currentKey, [...(sections.get(currentKey) ?? []), current.join('\n').trim()].filter(Boolean).join('\n'));
  }

  return sections;
}

function uniqueList(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function validationCommands(value) {
  return uniqueList(splitList(value).filter((line) => !line.endsWith(':')));
}

function isBroadScope(packet) {
  const scope = `${packet.goal}\n${packet.scope}`.toLowerCase();
  return /\b(app|backend|frontend|system|everything|all|across|whole repo|project-wide|cross-cutting)\b/.test(scope);
}

function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function escapeRegex(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function patternToRegex(pattern) {
  const normalized = normalizePath(pattern);
  const source = normalized
    .split(/(\*\*|\*)/g)
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      return escapeRegex(part);
    })
    .join('');
  return new RegExp(`^${source}$`);
}

export function pathMatchesAllowedPath(file, allowedPath) {
  const normalizedFile = normalizePath(file);
  const normalizedAllowedPath = normalizePath(allowedPath);

  if (!normalizedAllowedPath) {
    return false;
  }

  if (normalizedAllowedPath.endsWith('/**')) {
    const prefix = normalizedAllowedPath.slice(0, -3);
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }

  if (normalizedAllowedPath.includes('*')) {
    return patternToRegex(normalizedAllowedPath).test(normalizedFile);
  }

  return normalizedFile === normalizedAllowedPath || normalizedFile.startsWith(`${normalizedAllowedPath}/`);
}

export function filesOutsideAllowedPaths(files, allowedPaths) {
  if (!allowedPaths?.length) {
    return [];
  }

  return files.filter(
    (file) => !allowedPaths.some((allowedPath) => pathMatchesAllowedPath(file, allowedPath))
  );
}

export function parseTaskPacket(issue, config = {}) {
  const sections = sectionMap(issue.body ?? '');
  const requiredFields = [...(config.packetRequiredFields ?? REQUIRED_FIELDS)];
  const packet = {
    issueNumber: issue.number,
    title: issue.title,
    goal: compactText(sections.get('goal') ?? ''),
    scope: compactText(sections.get('scope') ?? ''),
    acceptanceCriteria: splitList(sections.get('acceptanceCriteria') ?? ''),
    validationCommands: validationCommands(sections.get('validationCommands') ?? ''),
    allowedPaths: splitList(sections.get('allowedPaths') ?? ''),
    suspectFiles: splitList(sections.get('suspectFiles') ?? ''),
    constraints: splitList(sections.get('constraints') ?? ''),
    source: 'issue-body'
  };

  const missingFields = requiredFields.filter((field) => {
    const value = packet[field];
    return Array.isArray(value) ? value.length === 0 : !value;
  });
  const needsLocalization = packet.allowedPaths.length === 0 && packet.suspectFiles.length === 0;
  const broadScope = isBroadScope(packet);
  const role = needsLocalization || (broadScope && packet.allowedPaths.length === 0) ? 'explorer' : 'fixer';

  return {
    ...packet,
    requiredFields,
    missingFields,
    complete: missingFields.length === 0,
    role,
    needsLocalization,
    broadScope
  };
}

export function packetStatus(packet) {
  if (packet.complete) {
    return packet.role === 'explorer' ? 'complete-needs-localization' : 'complete';
  }
  return 'incomplete';
}

export function formatMissingPacketComment(packet) {
  return `Codex daemon did not start this issue because the task packet is incomplete.

Missing required field${packet.missingFields.length === 1 ? '' : 's'}: ${packet.missingFields.join(', ')}.

Please add markdown sections for Goal, Scope, Acceptance Criteria, and Validation Commands, then move the item back to Ready.`;
}

export function formatScopeViolationComment(runId, files, allowedPaths) {
  return `Codex daemon run ${runId} stopped before commit because changed files were outside the packet Allowed Paths.

Allowed Paths:
${allowedPaths.map((allowedPath) => `- ${allowedPath}`).join('\n')}

Out-of-scope changed files:
${files.map((file) => `- ${file}`).join('\n')}

No commit or pull request was created. Please inspect the local workspace, narrow the packet, or move the issue back to Ready after cleanup.`;
}

export function formatTaskPacket(packet) {
  return JSON.stringify(
    {
      goal: packet.goal,
      scope: packet.scope,
      acceptance_criteria: packet.acceptanceCriteria,
      validation_commands: packet.validationCommands,
      allowed_paths: packet.allowedPaths,
      suspect_files: packet.suspectFiles,
      constraints: packet.constraints,
      role: packet.role
    },
    null,
    2
  );
}
