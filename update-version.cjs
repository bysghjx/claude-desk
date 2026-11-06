// Release versions use X.Y.Z with an optional SemVer prerelease suffix (beta, rc, etc.).
const number = '(?:0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION_SOURCE = number + '[.]' + number + '[.]' + number + '(?:-' + identifier + '(?:[.]' + identifier + ')*)?';
const pattern = new RegExp('^' + VERSION_SOURCE + '$(?![\\s\\S])');
const validVersion = value => typeof value === 'string' && pattern.test(value);
const prereleaseVersion = value => validVersion(value) && value.includes('-');
const numeric = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
function compareVersions(a, b) {
  if (!validVersion(a) || !validVersion(b)) throw Error('不支持的更新版本号');
  const [ac, ap] = a.split(/-(.*)/s), [bc, bp] = b.split(/-(.*)/s);
  const x = ac.split('.'), y = bc.split('.');
  for (let i = 0; i < 3; i++) { const c = numeric(x[i], y[i]); if (c) return c; }
  if (ap === undefined || bp === undefined) return ap === bp ? 0 : ap === undefined ? 1 : -1;
  const ax = ap.split('.'), bx = bp.split('.');
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    if (ax[i] === undefined || bx[i] === undefined) return ax[i] === undefined ? -1 : 1;
    if (ax[i] === bx[i]) continue;
    const an = /^[0-9]+$/.test(ax[i]), bn = /^[0-9]+$/.test(bx[i]);
    return an && bn ? numeric(ax[i], bx[i]) : an !== bn ? (an ? -1 : 1) : ax[i] < bx[i] ? -1 : 1;
  }
  return 0;
}
const newer = (a, b) => validVersion(a) && validVersion(b) && compareVersions(a, b) > 0;
module.exports = { VERSION_SOURCE, validVersion, prereleaseVersion, compareVersions, newer };
