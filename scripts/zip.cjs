const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Windows tar uses the system code page for paths; .NET preserves Unicode on every locale.
function createZip(dir, out) {
  fs.rmSync(out, { force: true });
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:CLAUDE_DESK_ZIP_SOURCE, $env:CLAUDE_DESK_ZIP_OUTPUT, [IO.Compression.CompressionLevel]::Optimal, $false)"],
    { windowsHide: true, env: { ...process.env, CLAUDE_DESK_ZIP_SOURCE: path.resolve(dir), CLAUDE_DESK_ZIP_OUTPUT: path.resolve(out) } });
  return fs.statSync(out).size;
}

module.exports = { createZip };
