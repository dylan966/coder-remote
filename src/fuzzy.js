function score(s, q) {
  s = s.toLowerCase(); q = q.toLowerCase(); let i = 0, sc = 0;
  for (const ch of s) { if (i < q.length && ch === q[i]) { i++; sc += 2; } }
  return i === q.length ? sc - s.length * 0.01 : -1;   // must match all query chars (as a subsequence)
}
function fuzzyRank(items, q) {
  if (!q) return items.slice();
  return items.map((x) => [x, score(x, q)]).filter(([, v]) => v >= 0)
    .sort((a, b) => b[1] - a[1]).map(([x]) => x);
}
module.exports = { fuzzyRank, score };
