import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const directory = mkdtempSync(join(tmpdir(), 'dioko-package-'));
try {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', resolve(process.argv[2]), 'react@18'], { cwd: directory, stdio: 'inherit' });
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createAnalytics } from '@dioko/analytics';
    import { createServerAnalytics } from '@dioko/analytics/server';
    import { AnalyticsProvider, useAnalytics } from '@dioko/analytics/react';
    for (const value of [createAnalytics, createServerAnalytics, AnalyticsProvider, useAnalytics]) assert.equal(typeof value, 'function');
  `], { cwd: directory, stdio: 'inherit' });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
