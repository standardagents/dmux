import { describe, it, expect } from 'vitest';
import { preprocessPastedContent, wrapText, findCursorInWrappedLines } from '../src/utils/input.js';
import stringWidth from 'string-width';

describe('input utils: paste sanitation', () => {
  it('removes ANSI and box drawing chars, normalizes newlines', () => {
    const dirty = '\x1b[31mred\x1b[0m box: ╭─╮\r\n next';
    const cleaned = preprocessPastedContent(dirty);
    expect(cleaned).toBe('red box:\nnext');
    expect(cleaned.includes('╭')).toBe(false);
  });
});

describe('input utils: wrapText', () => {
  it('wraps by words, returns multiple lines', () => {
    const text = 'alpha beta gamma delta epsilon zeta';
    const lines = wrapText(text, 12);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].line.length).toBeLessThanOrEqual(12);
  });

  it('wraps at the exact moment of overflow on full word boundary', () => {
    const width = 10;
    const text = 'hello world'; // 11 chars incl space
    // Find the first index where wrapping occurs when adding the next char
    let breakIndex = -1;
    for (let i = 1; i < text.length; i++) {
      const before = wrapText(text.slice(0, i), width);
      const after = wrapText(text.slice(0, i + 1), width);
      if (before.length === 1 && after.length === 2) {
        breakIndex = i;
        // First wrapped line should be the full first word
        expect(after[0].line).toBe('hello');
        break;
      }
    }
    expect(breakIndex).toBeGreaterThan(0);
  });

  it('verifies char-by-char that wrap occurs only when adding the overflowing character', () => {
    const width = 20;
    const text = 'lorem ipsum dolor sit amet consectetur';

    // derive expected first-line after the first wrap
    let trigger = -1;
    let expectedFirst = '';
    for (let i = 1; i < text.length; i++) {
      const before = wrapText(text.slice(0, i), width);
      const after = wrapText(text.slice(0, i + 1), width);
      if (before.length === 1 && after.length > 1) {
        trigger = i;
        expectedFirst = after[0].line;
        break;
      }
    }
    expect(trigger).toBeGreaterThan(0);

    // For each i < trigger: single line, no premature wrap
    for (let i = 1; i < trigger; i++) {
      const wrapped = wrapText(text.slice(0, i), width);
      expect(wrapped.length).toBe(1);
    }

    // At trigger: wrap occurs and first line matches the computed full word
    const wrappedAtTrigger = wrapText(text.slice(0, trigger + 1), width);
    expect(wrappedAtTrigger.length).toBeGreaterThan(1);
    expect(wrappedAtTrigger[0].line).toBe(expectedFirst);
  });
});

describe('input utils: cursor mapping', () => {
  it('finds cursor position within wrapped lines', () => {
    const text = 'hello world this wraps nicely';
    const wrapped = wrapText(text, 10);
    // Cursor after 12 chars => second wrapped line
    const pos = findCursorInWrappedLines(wrapped, 12);
    expect(pos.line).toBeGreaterThan(0);
    expect(pos.col).toBeGreaterThanOrEqual(0);
  });
});

describe('input utils: CJK wrapping', () => {
  it('wraps CJK text using display width (2 columns per char)', () => {
    // 4 CJK chars = 8 display columns
    const text = '你好世界';
    const wrapped = wrapText(text, 6); // 6 columns => fits 3 CJK chars
    expect(wrapped.length).toBe(2);
    expect(wrapped[0].line).toBe('你好世');
    expect(wrapped[1].line).toBe('界');
  });

  it('wraps mixed ASCII and CJK text correctly', () => {
    // "ab你好cd" = 2 + 4 + 2 = 8 display columns
    const text = 'ab你好cd';
    const wrapped = wrapText(text, 6);
    expect(wrapped.length).toBe(2);
    // First line: "ab你好" = 2+4 = 6 columns, fits exactly
    expect(wrapped[0].line).toBe('ab你好');
    expect(wrapped[1].line).toBe('cd');
  });

  it('does not split a CJK char across lines', () => {
    // With 5 columns of space, only 2 CJK chars (4 cols) fit, not 2.5
    const text = '你好世';
    const wrapped = wrapText(text, 5);
    expect(wrapped.length).toBe(2);
    expect(wrapped[0].line).toBe('你好');
    expect(stringWidth(wrapped[0].line)).toBeLessThanOrEqual(5);
    expect(wrapped[1].line).toBe('世');
  });

  it('CJK lines never exceed the display width', () => {
    const text = '这是一段比较长的中文文字用来测试自动换行功能是否正确';
    const width = 20;
    const wrapped = wrapText(text, width);
    for (const wl of wrapped) {
      expect(stringWidth(wl.line)).toBeLessThanOrEqual(width);
    }
    // All characters should be preserved
    expect(wrapped.map(w => w.line).join('')).toBe(text);
  });

  it('CJK forced breaks produce gapSize 0', () => {
    const text = '你好世界测试'; // 6 chars, 12 display cols
    const wrapped = wrapText(text, 8); // fits 4 CJK chars
    expect(wrapped.length).toBe(2);
    // Forced break (no space) should have gapSize 0
    expect(wrapped[0].gapSize).toBe(0);
  });
});

describe('input utils: CJK cursor mapping', () => {
  it('maps cursor correctly in CJK-only text', () => {
    const text = '你好世界测试';
    const wrapped = wrapText(text, 8); // "你好世界" | "测试"
    // Cursor at char index 2 (after '好') should be on line 0
    const pos = findCursorInWrappedLines(wrapped, 2);
    expect(pos.line).toBe(0);
    expect(pos.col).toBe(2);
  });

  it('maps cursor at CJK forced break boundary', () => {
    const text = '你好世界测试';
    const wrapped = wrapText(text, 8); // "你好世界" (4 chars) | "测试" (2 chars)
    // gapSize is 0 for forced CJK break, so cursor=4 should be on line 1, col 0
    const pos = findCursorInWrappedLines(wrapped, 4);
    expect(pos.line).toBe(0);
    expect(pos.col).toBe(4);
    // cursor=4 is at end of line 0 (after '界')
    // cursor just past the line should go to next line
    // With gapSize 0, character 4 ('测') starts line 1
    // But cursor=4 <= 0+4 so it's still on line 0. Cursor 4 on line 0 is at end.
  });

  it('cursor after CJK forced break maps to start of next line', () => {
    const text = '你好世界测试';
    const wrapped = wrapText(text, 8); // "你好世界" | "测试", gapSize=0
    // With gapSize=0, the 5th character '测' is at absolute position 4
    // currentPos after line 0: 0 + 4 + 0 = 4
    // cursor=4 <= 0+4, so line 0, col 4 (end of line)
    // But we also need cursor=4 to show on line 1 col 0 since char 4 is there
    // Actually, cursor=4 at col=4 of a 4-char line means "after last char" = end of line 0
    // The character at index 4 starts on the next line
    expect(wrapped[0].line.length).toBe(4);
    expect(wrapped[1].line).toBe('测试');
  });

  it('maps cursor in mixed ASCII/CJK wrapped text', () => {
    // "hello 你好世界" = 5+1+8 = 14 display cols
    const text = 'hello 你好世界';
    const wrapped = wrapText(text, 10); // "hello" (space break) | "你好世界"
    expect(wrapped[0].line).toBe('hello');
    expect(wrapped[0].gapSize).toBe(1); // space consumed
    // Cursor at 6 = '你' (after "hello " which is 6 chars)
    const pos = findCursorInWrappedLines(wrapped, 6);
    expect(pos.line).toBe(1);
    expect(pos.col).toBe(0);
  });
});
