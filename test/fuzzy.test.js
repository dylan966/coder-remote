const { test } = require('node:test'); const assert = require('node:assert');
const { fuzzyRank } = require('../src/fuzzy');
test('subsequence match + drop non-matches', () => {
  const r = fuzzyRank(['alpha', 'beta', 'backend'], 'ba');
  assert.deepEqual(r, ['beta', 'backend']);  // both contain the b..a subsequence; alpha has a..a, not ba, so it is dropped
});
test('empty query returns input unchanged', () => { assert.deepEqual(fuzzyRank(['x', 'y'], ''), ['x', 'y']); });
