const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validVersion, compareVersions, newer } = require('../update-version.cjs');
const versions = ['0.29.4', '0.30.0-alpha', '0.30.0-alpha.1', '0.30.0-alpha.beta', '0.30.0-beta', '0.30.0-beta.2', '0.30.0-beta.10', '0.30.0-rc.1', '0.30.0', '0.30.1-beta.1', '1.0.0'];
test('update ordering follows prerelease precedence and rejects malformed versions', () => {
  for (let i = 0; i < versions.length; i++) {
    assert.ok(validVersion(versions[i])); assert.equal(compareVersions(versions[i], versions[i]), 0);
    for (let j = 0; j < i; j++) { assert.ok(newer(versions[i], versions[j])); assert.ok(!newer(versions[j], versions[i])); }
  }
  for (const value of ['1x2x3', '1.2', '1.2.3.4', '01.2.3', '1.2.3-beta.01', '1.2.3-', '1.2.3-beta..1', '../1.2.3', '1.2.3\n', '1.2.3\r\n', null]) {
    assert.equal(validVersion(value), false, String(value)); assert.equal(newer(value, '1.0.0'), false);
  }
});
