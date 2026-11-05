const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixExe } = require('../scripts/package.cjs');

// What the packager writes per build: the app version and the hash of that build's app.asar.
async function packaged(dir, version, hash) {
  const { NtExecutable, NtExecutableResource, Resource } = await import('resedit');
  const exe = NtExecutable.from(fs.readFileSync(require('electron'))), res = NtExecutableResource.from(exe);
  const [info] = Resource.VersionInfo.fromEntries(res.entries), [lang] = info.getAllLanguagesForStringValues();
  info.setProductVersion(...version.split('.').map(Number)); info.setStringValues(lang, { ProductVersion: version });
  info.outputToResourceEntries(res.entries);
  const bin = Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: hash }]));
  res.entries.push({ type: 'INTEGRITY', id: 'ELECTRONASAR', bin: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length), lang: lang.lang, codepage: lang.codepage });
  res.outputResource(exe);
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'ClaudeDesk.exe'), Buffer.from(exe.generate()));
}

test('ClaudeDesk.exe comes out the same for every app version and app.asar', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-exe-'));
  try {
    const a = path.join(root, 'a'), b = path.join(root, 'b');
    await packaged(a, '0.29.1', '1'.repeat(64)); await packaged(b, '0.29.2', '2'.repeat(64));
    assert.notDeepEqual(fs.readFileSync(path.join(a, 'ClaudeDesk.exe')), fs.readFileSync(path.join(b, 'ClaudeDesk.exe')));
    await fixExe(a); await fixExe(b);
    const fixed = fs.readFileSync(path.join(a, 'ClaudeDesk.exe'));
    assert.ok(fixed.equals(fs.readFileSync(path.join(b, 'ClaudeDesk.exe'))));
    const { NtExecutable, NtExecutableResource, Resource } = await import('resedit');
    const res = NtExecutableResource.from(NtExecutable.from(fixed));
    assert.equal(res.entries.some(e => e.type === 'INTEGRITY'), false);
    const [info] = Resource.VersionInfo.fromEntries(res.entries);
    assert.equal(info.getStringValues(info.getAllLanguagesForStringValues()[0]).ProductVersion, '1.0.0.0');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an exe that validates app.asar keeps its hash and the build stops', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-exe-'));
  try {
    // The fuse wire: sentinel, version, length, then one byte per fuse ('1' = on); fuse 4 is asar integrity.
    fs.writeFileSync(path.join(dir, 'ClaudeDesk.exe'), Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 8]), Buffer.from('01011001')]));
    await assert.rejects(fixExe(dir), /会校验 app.asar/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
