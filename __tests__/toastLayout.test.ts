import { describe, expect, it } from 'vitest';
import { getToastSectionLayout } from '../src/utils/toastLayout.js';

describe('toast layout', () => {
  it('uses display width when sizing CJK toasts', () => {
    const layout = getToastSectionLayout(
      { message: '你好世界你好世界你好世界你好世界你好你' },
      0,
      38,
    );

    expect(layout.toastHeight).toBe(3);
    expect(layout.footerExtraLines).toBe(4);
  });

  it('keeps queued-toast transition height in sync', () => {
    const layout = getToastSectionLayout(null, 2, 38);

    expect(layout.toastHeight).toBe(1);
    expect(layout.footerExtraLines).toBe(2);
  });

  it('returns zero height when there are no notifications', () => {
    const layout = getToastSectionLayout(null, 0, 38);

    expect(layout.toastHeight).toBe(0);
    expect(layout.footerExtraLines).toBe(0);
  });
});
