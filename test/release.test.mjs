import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, parseVersion, shouldRelease, verifyExisting } from '../scripts/release.mjs';

test('unchanged versions skip publishing, manual retries proceed, decreases fail', () => {
  assert.equal(shouldRelease('0.1.0', '0.1.0'), false);
  assert.equal(shouldRelease('0.1.1', '0.1.0'), true);
  assert.equal(shouldRelease('0.1.1', '0.1.1', true), true);
  assert.throws(() => shouldRelease('0.1.0', '0.2.0'));
  assert.throws(() => shouldRelease('0.1.0', undefined));
});
test('release precedence follows semver including numeric prereleases', () => {
  const versions = ['0.1.0-alpha', '0.1.0-alpha.1', '0.1.0-alpha.2', '0.1.0-alpha.10', '0.1.0-beta', '0.1.0', '0.1.1', '0.2.0', '1.0.0'];
  for (let i = 1; i < versions.length; i++) {
    assert.equal(compareVersions(versions[i], versions[i - 1]), 1);
    assert.equal(compareVersions(versions[i - 1], versions[i]), -1);
  }
  for (const version of versions) assert.equal(compareVersions(version, version), 0);
});
test('invalid and ambiguous release versions are rejected', () => {
  for (const version of ['v1.0.0', '01.0.0', '1.0', '1.0.0-beta.01', '1.0.0+build', '1.0.0-']) {
    assert.throws(() => parseVersion(version));
  }
});
test('retry accepts identical published bytes and rejects mismatched or missing integrity', () => {
  verifyExisting({ dist: { integrity: 'sha512-same' } }, 'sha512-same');
  assert.throws(() => verifyExisting({ dist: { integrity: 'sha512-other' } }, 'sha512-same'));
  assert.throws(() => verifyExisting({}, 'sha512-same'));
});
