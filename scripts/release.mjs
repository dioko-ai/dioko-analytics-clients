import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
export function parseVersion(value) {
  // Build metadata is intentionally excluded: npm versions must identify a unique release.
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[4]?.split('.').some(id => /^\d+$/.test(id) && id.length > 1 && id[0] === '0')) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') };
}
export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
export function shouldRelease(current, previous, manual = false) {
  parseVersion(current);
  if (previous === undefined) throw new Error('Cannot determine previous version; use a manual run on main.');
  const comparison = compareVersions(current, previous);
  if (comparison < 0) throw new Error('Package version must not decrease.');
  return manual || comparison > 0;
}
export function verifyExisting(metadata, integrity) {
  if (metadata.dist?.integrity !== integrity) {
    throw new Error('Version already exists with different contents. Do not overwrite it; bump the version.');
  }
}
async function main() {
  const pkg = JSON.parse(readFileSync('package.json'));
  const command = process.argv[2];
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Releases must run on main.');
  const lock = JSON.parse(readFileSync('package-lock.json'));
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) throw new Error('Lockfile version mismatch.');
  parseVersion(pkg.version);
  if (command === 'plan') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH));
    const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
    let previous = pkg.version;
    if (!manual) {
      if (!event.before || /^0+$/.test(event.before) || event.forced) throw new Error('Cannot release from a new branch or force push.');
      previous = JSON.parse(run('git', ['show', `${event.before}:package.json`])).version;
    }
    const release = shouldRelease(pkg.version, previous, manual);
    if (release) {
      const tag = `v${pkg.version}`;
      if (run('git', ['tag', '--list', tag]) && run('git', ['rev-list', '-n', '1', tag]) !== process.env.GITHUB_SHA) {
        throw new Error(`${tag} already points to another commit.`);
      }
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `release=${release}\nversion=${pkg.version}\ntag=v${pkg.version}\nchannel=${pkg.version.includes('-') ? 'next' : 'latest'}\n`);
    console.log(release ? `Preparing ${pkg.name}@${pkg.version}` : 'Version unchanged; no release.');
  } else if (command === 'publish') {
    const tarball = process.argv[3];
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`);
    if (response.ok) {
      verifyExisting(await response.json(), integrity);
      console.log('Identical package already published; continuing with GitHub release.');
    } else if (response.status === 404) {
      if (!pkg.version.includes('-')) {
        const latest = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`);
        if (!latest.ok) throw new Error(`Cannot verify latest version: HTTP ${latest.status}`);
        if (compareVersions(pkg.version, (await latest.json()).version) <= 0) {
          throw new Error('Stable releases must be newer than npm latest.');
        }
      }
      execFileSync('npm', ['publish', tarball, '--access', 'public', '--tag', pkg.version.includes('-') ? 'next' : 'latest', '--registry', 'https://registry.npmjs.org'], { stdio: 'inherit' });
    } else {
      throw new Error(`Registry lookup failed: HTTP ${response.status}`);
    }
  } else throw new Error(`Unknown command: ${command}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
