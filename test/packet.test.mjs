import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filesOutsideAllowedPaths,
  parseTaskPacket,
  pathMatchesAllowedPath,
  packetStatus
} from '../tools/codex-daemon/packet.mjs';

function issue(body) {
  return {
    number: 7,
    title: 'Packet test',
    body
  };
}

test('complete packet is accepted and localized paths choose fixer', () => {
  const packet = parseTaskPacket(issue(`## Goal
Ship the narrow change.

## Scope
- Update only the daemon prompt.

## Allowed Paths
- tools/codex-daemon/prompts.mjs

## Acceptance Criteria
- [ ] Prompt includes packet JSON.

## Validation Commands
- npm run check
`));

  assert.equal(packet.complete, true);
  assert.equal(packet.role, 'fixer');
  assert.equal(packetStatus(packet), 'complete');
  assert.deepEqual(packet.validationCommands, ['npm run check']);
});

test('missing goal blocks dispatch', () => {
  const packet = parseTaskPacket(issue(`## Scope
- Update daemon docs.

## Acceptance Criteria
- [ ] README describes packet fields.

## Validation Commands
- npm run check
`));

  assert.equal(packet.complete, false);
  assert.deepEqual(packet.missingFields, ['goal']);
  assert.equal(packetStatus(packet), 'incomplete');
});

test('missing validation blocks dispatch', () => {
  const packet = parseTaskPacket(issue(`## Goal
Update daemon docs.

## Scope
- README only.

## Acceptance Criteria
- [ ] README describes packet fields.
`));

  assert.equal(packet.complete, false);
  assert.deepEqual(packet.missingFields, ['validationCommands']);
});

test('broad issue with no localization chooses explorer', () => {
  const packet = parseTaskPacket(issue(`## Goal
Improve the whole app startup flow.

## Scope
- Review frontend and backend startup behavior.

## Acceptance Criteria
- [ ] Startup behavior is clearer.

## Validation Commands
- npm run check
`));

  assert.equal(packet.complete, true);
  assert.equal(packet.role, 'explorer');
  assert.equal(packet.needsLocalization, true);
  assert.equal(packetStatus(packet), 'complete-needs-localization');
});

test('allowed paths skip explorer mode', () => {
  const packet = parseTaskPacket(issue(`## Goal
Improve the whole app startup flow.

## Scope
- Update only the CLI help text.

## Allowed Paths
- tools/codex-daemon/index.mjs

## Acceptance Criteria
- [ ] Help text mentions packet status.

## Validation Commands
- npm run check
`));

  assert.equal(packet.complete, true);
  assert.equal(packet.role, 'fixer');
});

test('allowed path matcher supports exact files and directory globs', () => {
  assert.equal(pathMatchesAllowedPath('README.md', 'README.md'), true);
  assert.equal(pathMatchesAllowedPath('supabase/migrations/001.sql', 'supabase/migrations/**'), true);
  assert.equal(pathMatchesAllowedPath('src/App.tsx', 'src/*.tsx'), true);
  assert.equal(pathMatchesAllowedPath('src/components/Button.tsx', 'src/*.tsx'), false);
});

test('files outside allowed paths are reported before commit', () => {
  const outside = filesOutsideAllowedPaths(
    ['daemon-workflow-proof.md', 'tools/codex-daemon/index.mjs'],
    ['daemon-workflow-proof.md']
  );

  assert.deepEqual(outside, ['tools/codex-daemon/index.mjs']);
});
