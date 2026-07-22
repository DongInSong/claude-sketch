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

// Every directory shares the same leading segments when the work sits below one
// part of the tree — show that prefix once in the header, strip it from every
// label that has it.
//
// It used to require *every* directory to share it, which meant one stray folder
// zeroed it for all of them: a single file written to .playwright-mcp/ was enough
// to stop docs/product-intro/20260622/captures/ being taken off the nine rows
// that did share it, and measured across real sessions it came out empty every
// time. So it is the longest prefix most of them share, and a directory outside
// it simply keeps its whole name — stripRoot already leaves those alone.
// Absolute paths count too. Claude Code records the directory it was started in,
// and work above that stays absolute — run it in a repo's bin/ and the whole of
// lib/, public/ and test/ arrives as /home/…/project/lib and friends. Skipping
// those left the common prefix empty exactly when it was needed most.
export function computeRoot(dirs, share = 0.6) {
  const usable = dirs.filter(d => d && !d.startsWith('('));
  if (usable.length < 2) return '';
  const need = Math.max(2, Math.ceil(usable.length * share));

  const seen = new Map();                  // prefix -> how many directories are under it
  for (const d of usable) {
    const abs = d.startsWith('/');
    const seg = d.split('/').filter(Boolean);
    for (let i = 1; i <= seg.length; i++) {
      const pre = (abs ? '/' : '') + seg.slice(0, i).join('/');
      seen.set(pre, (seen.get(pre) || 0) + 1);
    }
  }
  let best = '';
  for (const [pre, n] of seen)
    if (n >= need && pre.length > best.length) best = pre;
  return best;
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
