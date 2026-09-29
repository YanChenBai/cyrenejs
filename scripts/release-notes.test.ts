import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vite-plus/test';

import { formatCommits, formatReleaseNotes, readPackageHistory } from './release-notes.ts';

test('classifies commit prefixes and breaking footers, preserves scope and PR links', () => {
  const commit = (subject: string, body = '') => `abcdef123456\0${subject}\0${body}\0\n`;

  const notes = formatCommits(
    [
      commit('feat(core): add lazy dependencies (#12)'),
      commit('fix: handle disposal'),
      commit('docs: explain lazy loading'),
      commit('refactor(core)!: remove old API'),
      commit('fix: change return value', 'BREAKING CHANGE: Return a promise.'),
      commit('chore: version packages (#13)'),
      commit('Unprefixed commit'),
    ].join(''),
  );

  assert.match(notes, /### ✨ Features\n\n- \*\*core:\*\* add lazy dependencies/);
  assert.match(notes, /pull\/12/);
  assert.match(notes, /### 🐛 Fixes & Enhancements\n\n- handle disposal/);
  assert.match(notes, /### 📚 Docs/);
  assert.match(notes, /### 💥 Breaking Changes\n\n- \*\*core:\*\* remove old API/);
  assert.match(notes, /change return value/);
  assert.match(notes, /### 📝 Other Changes\n\n- Unprefixed commit/);
  assert.doesNotMatch(notes, /version packages/);
});

test('uses reachable package tags and excludes other packages and later commits', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cyrene-commit-notes-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const commit = (file: string, subject: string) => {
    writeFileSync(join(cwd, file), subject);
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      subject,
    );
  };

  mkdirSync(join(cwd, 'packages/core'), { recursive: true });
  mkdirSync(join(cwd, 'packages/elysia'), { recursive: true });

  git('init', '-b', 'master');

  commit('packages/core/index.ts', 'feat: old core implementation');
  git('tag', 'v0.0.3');

  commit('packages/elysia/index.ts', 'feat: integration');
  git('tag', '@cyrenejs/elysia@0.0.1');

  commit('packages/core/index.ts', 'fix(core): repair disposal');
  commit('packages/elysia/index.ts', 'docs: document integration');

  git('tag', 'cyrenejs@0.0.4');

  commit('packages/core/index.ts', 'feat: future feature');

  const core = readPackageHistory(cwd, { name: 'cyrenejs', version: '0.0.4' }, 'packages/core');

  assert.equal(core.previousTag, 'v0.0.3');
  assert.match(core.body, /repair disposal/);
  assert.doesNotMatch(core.body, /integration|future feature|old core/);

  const elysia = readPackageHistory(
    cwd,
    { name: '@cyrenejs/elysia', version: '0.0.2' },
    'packages/elysia',
  );

  assert.equal(elysia.previousTag, '@cyrenejs/elysia@0.0.1');
  assert.match(elysia.body, /### 📚 Docs/);
  assert.doesNotMatch(elysia.body, /repair disposal|future feature/);

  const first = readPackageHistory(
    cwd,
    { name: '@cyrenejs/elysia', version: '0.0.1' },
    'packages/elysia',
  );

  assert.equal(first.previousTag, undefined);
  assert.match(first.body, /### ✨ Features/);
  assert.doesNotMatch(first.body, /document integration/);
});

test('formats package-specific links and handles empty releases', () => {
  const notes = formatReleaseNotes(
    { name: '@cyrenejs/elysia', version: '0.2.0-beta.1' },
    formatCommits(''),
    '@cyrenejs/elysia@0.1.0',
  );

  assert.match(notes, /npm install @cyrenejs\/elysia@0.2.0-beta.1/);
  assert.match(
    notes,
    /compare\/%40cyrenejs%2Felysia%400.1.0\.\.\.%40cyrenejs%2Felysia%400.2.0-beta.1/,
  );
  assert.match(notes, /No package-specific commits/);
});
