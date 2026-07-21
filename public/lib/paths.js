// Turning transcript paths into the labels the panels show. Pure string work,
// kept out of index.html so it can be tested — the last bug here (a Windows
// path never matching the file universe) went unnoticed for a whole release.

// A tool call's target, bucketed into the directory it belongs to. Web fetches
// and searches have no directory, so they get one of their own.
export function dirOf(p) {
  if (p.startsWith('web: ') || p.startsWith('http')) return '(web)';
  return p.includes('/') ? p.split('/').slice(0, -1).join('/') : '(root)';
}

// Time spent in here is usually time wasted: caches, build output, vendored deps.
export function isWastePath(p) {
  return /(^|\/)(node_modules|\.deps|\.venv|venv|__pycache__|dist|build|\.cache|data\/cache)(\/|$)/.test(p);
}

// '/a/b/c/d' → '…/c/d'; bucket names like '(root)' are left alone
export function shortDir(d, keep) {
  if (d.startsWith('(')) return d;
  const seg = d.split('/').filter(Boolean);
  return seg.length > (keep || 2) ? '…/' + seg.slice(-(keep || 2)).join('/') : d;
}

// Every directory shares the same leading segments when the work sits below the
// project root — show that prefix once in the header, strip it from every label.
export function computeRoot(dirs) {
  const rel = dirs.filter(d => d && !d.startsWith('(') && !d.startsWith('/'));
  if (rel.length < 2) return '';
  let pre = rel[0].split('/');
  for (const d of rel.slice(1)) {
    const seg = d.split('/');
    let i = 0;
    while (i < pre.length && i < seg.length && pre[i] === seg[i]) i++;
    pre = pre.slice(0, i);
    if (!pre.length) return '';
  }
  return pre.join('/');
}

export function stripRoot(d, root) {
  if (!root || d.startsWith('(')) return d;
  if (d === root) return './';
  return d.startsWith(root + '/') ? d.slice(root.length + 1) : d;
}

export const dirLabel = (d, keep, root) => shortDir(stripRoot(d, root), keep);

// claude-opus-4-8-20260101 → opus-4-8
export function shortModel(m) {
  return String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}
