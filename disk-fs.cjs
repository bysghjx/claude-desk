// External files are real disk files, even when their names end in .asar.
// Keep Electron's patched fs for loading the app's own packaged resources.
module.exports=process.versions.electron?require('original-fs'):require('node:fs');
