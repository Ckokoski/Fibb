import { describe, it, expect } from 'vitest';
import { TALLY_EXAMPLE, SPRINT_TIMER_EXAMPLE } from './tool-shelf.js';
import { checkTool } from './tool-shelf-check.js';

describe('the worked example given to the model', () => {
  it('passes the safety checker it is meant to teach', () => {
    const r = checkTool('bookmarklet', [{ path: 'bookmarklet.js', content: TALLY_EXAMPLE }]);
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('the page example passes it too, and fits well inside the size limit', () => {
    const r = checkTool('page', [{ path: 'page.html', content: SPRINT_TIMER_EXAMPLE }]);
    expect(r.reasons).toEqual([]);
    expect(r.details).toEqual([]);
    expect(r.ok).toBe(true);
    expect(Buffer.byteLength(SPRINT_TIMER_EXAMPLE)).toBeLessThan(8 * 1024);
  });
});
