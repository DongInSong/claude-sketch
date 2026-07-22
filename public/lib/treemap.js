// Layout maths for the attention treemap, and the score that decides how hot a
// file looks. No canvas, no DOM — the drawing stays in the page.

// Squarified treemap (Bruls, Huizing, van Wijk): fill the box row by row,
// extending a row while it keeps the tiles closer to square. Each item is
// {wt, …} and comes back with a .rect; items are laid out in the order given,
// so sort by weight before calling.
export function squarify(items, x, y, w, h) {
  let i = 0;
  while (i < items.length && w > 0.5 && h > 0.5) {
    const horiz = w >= h;
    const side = horiz ? h : w;
    const total = items.slice(i).reduce((a, b) => a + b.wt, 0);
    if (!(total > 0)) break;      // nothing left to divide: rects would come out NaN
    const area = w * h;
    let best = Infinity, count = 1, rowSum = 0;
    for (let j = i; j < items.length; j++) {
      rowSum += items[j].wt;
      const thick = (rowSum / total) * area / side;
      let worst = 0;
      for (let k = i; k <= j; k++) {
        const len = items[k].wt / rowSum * side;
        worst = Math.max(worst, thick / Math.max(1e-6, len), len / Math.max(1e-6, thick));
      }
      if (worst <= best) { best = worst; count = j - i + 1; } else break;   // adding another made it worse
    }
    const rowW = items.slice(i, i + count).reduce((a, b) => a + b.wt, 0);
    const thick = (rowW / total) * area / side;
    let off = 0;
    for (let k = i; k < i + count; k++) {
      const len = items[k].wt / rowW * side;
      items[k].rect = horiz ? { x, y: y + off, w: thick, h: len }
                            : { x: x + off, y, w: len, h: thick };
      off += len;
    }
    if (horiz) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    i += count;
  }
  return items;
}

// Recent activity outweighs old activity — each bucket back counts 10% less —
// with a small floor from the running total so a long-worked file never reads
// as completely cold.
export function heatScore(fs, nowIx, cols) {
  let sc = 0;
  for (let i = 0; i < cols; i++) {
    const n = fs.hb[nowIx - i];
    if (n) sc += n * Math.pow(0.9, i);
  }
  return sc + fs.total * 0.04;
}
