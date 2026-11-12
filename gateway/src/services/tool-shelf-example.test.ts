import { describe, it, expect } from 'vitest';
import { TALLY_EXAMPLE } from './tool-shelf.js';
import { checkTool } from './tool-shelf-check.js';

describe('the worked example given to the model', () => {
  it('passes the safety checker it is meant to teach', () => {
    const r = checkTool('bookmarklet', [{ path: 'bookmarklet.js', content: TALLY_EXAMPLE }]);
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
