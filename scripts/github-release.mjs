import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const { version } = JSON.parse(readFileSync('package.json'));
const tag = `v${version}`;
const sha = process.env.GITHUB_SHA;
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
const tags = git(['tag', '--list', tag]);
if (tags) {
  if (git(['rev-list', '-n', '1', tag]) !== sha) throw new Error(`${tag} points to another commit.`);
} else {
  git(['tag', tag, sha]);
  git(['push', 'origin', `refs/tags/${tag}`]);
}
const url = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${tag}`;
const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' } });
if (response.status === 404) {
  const args = ['release', 'create', tag, '--verify-tag', '--title', tag, '--generate-notes'];
  if (version.includes('-')) args.push('--prerelease');
  execFileSync('gh', args, { stdio: 'inherit' });
} else if (!response.ok) {
  throw new Error(`GitHub release lookup failed: HTTP ${response.status}`);
} else {
  console.log(`GitHub release ${tag} already exists.`);
}
