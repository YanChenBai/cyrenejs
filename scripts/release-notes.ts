import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'YanChenBai/cyrenejs';
const repositoryUrl = `https://github.com/${repository}`;

type PublishedPackage = { name: string; version: string };

const BREAKING_CATEGORY = '💥 Breaking Changes';
const OTHER_CATEGORY = '📝 Other Changes';

const categories: Record<string, string> = {
  feat: '✨ Features',
  fix: '🐛 Fixes & Enhancements',
  perf: '⚡ Performance',
  refactor: '♻️ Refactoring',
  docs: '📚 Docs',
  test: '🧪 Tests',
  build: '📦 Build',
  ci: '👷 CI',
  chore: '🔧 Chore',
  style: '🎨 Styles',
  revert: '⏪ Reverts',
};

function formatCommit(hash: string, subject: string, body: string) {
  const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/.exec(subject);
  const breaking = Boolean(match?.[3]) || /^BREAKING[ -]CHANGE:\s/m.test(body);

  const category = breaking ? BREAKING_CATEGORY : (categories[match?.[1] ?? ''] ?? OTHER_CATEGORY);

  const summary = match?.[4] ?? subject;
  const scope = match?.[2] ? `**${match[2]}:** ` : '';
  const linkedSummary = summary.replace(/\(#(\d+)\)$/, `([#$1](${repositoryUrl}/pull/$1))`);
  const line = `- ${scope}${linkedSummary} ([\`${hash.slice(0, 7)}\`](${repositoryUrl}/commit/${hash}))`;

  return { category, line };
}

export function formatCommits(log: string) {
  const groups = new Map<string, string[]>();
  const fields = log.split('\0');

  for (let index = 0; index + 2 < fields.length; index += 3) {
    const hash = fields[index]!.trim();
    const subject = fields[index + 1]!;
    const body = fields[index + 2]!;

    if (/^chore(?:\(release\))?: (?:version|release) packages(?: \(#\d+\))?$/.test(subject)) {
      continue;
    }

    const { category, line } = formatCommit(hash, subject, body);
    const entries = groups.get(category) ?? [];
    entries.push(line);
    groups.set(category, entries);
  }

  return (
    [BREAKING_CATEGORY, ...Object.values(categories), OTHER_CATEGORY]
      .filter(category => groups.has(category))
      .map(category => `### ${category}\n\n${groups.get(category)!.join('\n')}`)
      .join('\n\n') || 'No package-specific commits in this release.'
  );
}

export function readPackageHistory(cwd: string, pkg: PublishedPackage, directory: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const tag = `${pkg.name}@${pkg.version}`;
  const tags = git('tag', '--list').split('\n');

  const currentTag = [tag, ...(pkg.name === 'cyrenejs' ? [`v${pkg.version}`] : [])].find(item =>
    tags.includes(item),
  );

  const end = currentTag ?? 'HEAD';
  const parents = git('rev-list', '--parents', '-n', '1', end).split(' ');
  const previousEnd = currentTag ? parents[1] : end;
  const patterns = [`${pkg.name}@*`];

  if (pkg.name === 'cyrenejs') {
    patterns.push('v[0-9]*');
  }

  let previousTag: string | undefined;

  if (previousEnd && git('tag', '--merged', previousEnd, '--list', ...patterns)) {
    previousTag = git(
      'describe',
      '--tags',
      '--abbrev=0',
      ...patterns.flatMap(pattern => ['--match', pattern]),
      previousEnd,
    );
  }

  const range = previousTag ? `${previousTag}..${end}` : end;
  const log = git('log', '--no-merges', '--format=%H%x00%s%x00%b%x00', range, '--', directory);

  return { body: formatCommits(log), previousTag };
}

export function formatReleaseNotes(pkg: PublishedPackage, body: string, previousTag?: string) {
  const tag = `${pkg.name}@${pkg.version}`;

  const changesUrl = previousTag
    ? `${repositoryUrl}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(tag)}`
    : `${repositoryUrl}/commits/${encodeURIComponent(tag)}`;

  return `${body}

### Published Packages

- [\`${tag}\`](https://www.npmjs.com/package/${pkg.name}/v/${pkg.version})

### Upgrade

\`\`\`sh
npm install ${tag}
\`\`\`

Full Changelog: [${previousTag ? `${previousTag}...${tag}` : tag}](${changesUrl})
`;
}

function requestedPackages(args: string[]): PublishedPackage[] {
  const [name, version] = args.filter(arg => arg !== '--publish');

  const requested: PublishedPackage[] =
    name && version ? [{ name, version }] : JSON.parse(process.env.PUBLISHED_PACKAGES || '[]');

  if (!Array.isArray(requested) || !requested.length) {
    throw new Error('Usage: vp run release-notes <package> <version> [--publish]');
  }

  return requested;
}

function main() {
  const args = process.argv.slice(2);
  const publish = args.includes('--publish');
  const requested = requestedPackages(args);

  const packages = readdirSync(join(root, 'packages')).map(directory => {
    const path = join(root, 'packages', directory);
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));

    return {
      path,
      name: manifest.name as string,
      private: manifest.private as boolean | undefined,
    };
  });

  for (const pkg of requested) {
    const local = packages.find(item => item.name === pkg.name && !item.private);

    if (
      !local ||
      typeof pkg.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)
    ) {
      throw new Error(`Invalid public package release: ${JSON.stringify(pkg)}`);
    }

    const release = readPackageHistory(root, pkg, local.path);
    const notes = formatReleaseNotes(pkg, release.body, release.previousTag);

    if (!publish) {
      process.stdout.write(notes);
      continue;
    }

    // Changesets 已创建 Release；这里只更新展示，失败后可以单独重跑。
    execFileSync(
      'gh',
      [
        'release',
        'edit',
        `${pkg.name}@${pkg.version}`,
        '--repo',
        repository,
        '--title',
        `${pkg.name} v${pkg.version}`,
        '--notes-file',
        '-',
      ],
      {
        cwd: root,
        input: notes,
        stdio: ['pipe', 'inherit', 'inherit'],
      },
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
