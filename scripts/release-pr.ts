import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const repository = 'YanChenBai/cyrenejs';
const baseBranch = 'master';
const primaryPackage = 'cyrenejs';

type ReleaseType = 'major' | 'minor' | 'patch' | 'none';

type Release = {
  name: string;
  type: ReleaseType;
  oldVersion: string;
  newVersion: string;
  changesets: string[];
};

type ChangesetStatus = {
  releases: Release[];
};

type PackageInfo = {
  name: string;
  directory: string;
};

const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  }).trim();

const gh = (...args: string[]) =>
  execFileSync('gh', args, {
    cwd: root,
    encoding: 'utf8',
  }).trim();

const vp = (...args: string[]) =>
  execFileSync('vp', args, {
    cwd: root,
    encoding: 'utf8',
  }).trim();

function readChangesetStatus(): ChangesetStatus {
  const directory = mkdtempSync(join(tmpdir(), 'cyrene-release-'));
  const path = join(directory, 'status.json');

  try {
    vp('exec', 'changeset', 'status', '--output', path);

    return JSON.parse(readFileSync(path, 'utf8')) as ChangesetStatus;
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
}

function readPackages(): PackageInfo[] {
  return readdirSync(join(root, 'packages'), {
    withFileTypes: true,
  })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const directory = `packages/${entry.name}`;

      const manifest = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')) as {
        name: string;
      };

      return {
        name: manifest.name,
        directory,
      };
    });
}

function findPreviousTag(packageName: string) {
  const patterns = [`${packageName}@*`];

  if (packageName === primaryPackage) {
    patterns.push('v[0-9]*');
  }

  for (const pattern of patterns) {
    const tag = git('tag', '--merged', 'HEAD', '--sort=-version:refname', '--list', pattern)
      .split('\n')
      .find(Boolean);

    if (tag) {
      return tag;
    }
  }

  return undefined;
}

function commitShasForPackage(pkg: PackageInfo) {
  const previousTag = findPreviousTag(pkg.name);
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';

  const output = git('log', '--no-merges', '--format=%H', range, '--', pkg.directory);

  return output ? output.split('\n').filter(Boolean) : [];
}

function resolveContributor(sha: string) {
  try {
    const login = gh('api', `repos/${repository}/commits/${sha}`, '--jq', '.author.login // empty');

    if (login) {
      return `@${login}`;
    }
  } catch {
    // Commit may not be associated with a GitHub account.
  }

  const name = git('show', '-s', '--format=%aN', sha);

  return name || undefined;
}

function readContributors(releases: Release[], packages: PackageInfo[]) {
  const commits = new Set<string>();

  for (const release of releases) {
    const pkg = packages.find(item => item.name === release.name);

    if (!pkg) {
      continue;
    }

    for (const sha of commitShasForPackage(pkg)) {
      commits.add(sha);
    }
  }

  const contributors = new Set<string>();

  for (const sha of commits) {
    const contributor = resolveContributor(sha);

    if (!contributor) {
      continue;
    }

    if (contributor.endsWith('[bot]') || contributor === '@github-actions') {
      continue;
    }

    contributors.add(contributor);
  }

  return [...contributors].sort((a, b) => a.localeCompare(b));
}

function formatPackage(release: Release) {
  return `- \`${release.name}\`: \`${release.oldVersion}\` → \`${release.newVersion}\``;
}

function createTitle(releases: Release[]) {
  const versions = new Set(releases.map(release => release.newVersion));

  if (versions.size === 1) {
    const [version] = versions;
    const packages = releases.map(release => release.name).join(', ');

    return `chore(release): prepare ${packages} v${version}`;
  }

  const packages = releases.map(release => `${release.name}@${release.newVersion}`).join(', ');

  return `chore(release): prepare ${packages}`;
}

function createCompareUrl(previousTag: string, branch: string) {
  const base = encodeURIComponent(previousTag);
  const head = encodeURIComponent(branch);

  return `https://github.com/${repository}/compare/${base}...${head}`;
}

function createBody(releases: Release[], contributors: string[], branch: string) {
  const packages = releases.map(formatPackage).join('\n');
  const previousTag = findPreviousTag(primaryPackage);

  const changes = previousTag
    ? `[compare changes](${createCompareUrl(previousTag, branch)})`
    : 'No previous release.';

  const contributorList =
    contributors.length > 0 ? contributors.join(' ') : 'No contributors detected.';

  return `## 📦 Release

${packages}

## 🔍 Changes

${changes}

## 👥 Contributors

${contributorList}
`;
}

function findExistingPullRequest(branch: string) {
  const result = gh(
    'pr',
    'list',
    '--base',
    baseBranch,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
    '--jq',
    '.[0].number // empty',
  );

  return result ? Number(result) : undefined;
}

function ensureBranchPushed(branch: string) {
  const remote = git('ls-remote', '--heads', 'origin', branch);

  if (!remote) {
    throw new Error(`Branch "${branch}" has not been pushed to origin.`);
  }
}

function main() {
  const branch = git('branch', '--show-current');

  if (!branch) {
    throw new Error('Unable to determine the current branch.');
  }

  if (branch === baseBranch) {
    throw new Error(`Release PR must be created from a non-${baseBranch} branch.`);
  }

  ensureBranchPushed(branch);

  const status = readChangesetStatus();

  if (!status.releases.length) {
    throw new Error('No packages are scheduled for release.');
  }

  const packages = readPackages();
  const contributors = readContributors(status.releases, packages);
  const title = createTitle(status.releases);
  const body = createBody(status.releases, contributors, branch);

  const existing = findExistingPullRequest(branch);

  if (existing) {
    execFileSync('gh', ['pr', 'edit', String(existing), '--title', title, '--body', body], {
      cwd: root,
      stdio: 'inherit',
    });

    return;
  }

  execFileSync(
    'gh',
    ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', title, '--body', body],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
}

main();
