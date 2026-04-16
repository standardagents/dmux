import { describe, it, expect } from 'vitest';
import { preprocessPastedContent, wrapText, findCursorInWrappedLines, findCharIndexAtWidth } from '../src/utils/input.js';
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

  it('wraps astral Unicode symbols without overflowing the target width', () => {
    const text = '\u{1F642}\u{1F642}';
    const wrapped = wrapText(text, 2);
    expect(findCharIndexAtWidth(text, 2)).toBe(2);
    expect(wrapped.length).toBe(2);
    expect(wrapped[0].line).toBe('\u{1F642}');
    expect(wrapped[1].line).toBe('\u{1F642}');
    for (const wl of wrapped) {
      expect(stringWidth(wl.line)).toBeLessThanOrEqual(2);
    }
  });

  it('wraps mixed ASCII and astral Unicode symbols by display width', () => {
    const text = `a${'\u{1F642}'}b`;
    const wrapped = wrapText(text, 3);
    expect(wrapped.length).toBe(2);
    expect(wrapped[0].line).toBe(`a${'\u{1F642}'}`);
    expect(wrapped[1].line).toBe('b');
    for (const wl of wrapped) {
      expect(stringWidth(wl.line)).toBeLessThanOrEqual(3);
    }
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
    // (the character '测' is at absolute index 4 and starts line 1)
    const pos = findCursorInWrappedLines(wrapped, 4);
    expect(pos.line).toBe(1);
    expect(pos.col).toBe(0);
  });

  it('cursor after CJK forced break maps to start of next line', () => {
    const text = '你好世界测试';
    const wrapped = wrapText(text, 8); // "你好世界" | "测试", gapSize=0
    // cursor=4 maps to line 1, col 0 ('测')
    const pos = findCursorInWrappedLines(wrapped, 4);
    expect(pos.line).toBe(1);
    expect(pos.col).toBe(0);
    expect(wrapped[1].line[0]).toBe('测');
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

describe('input utils: CJK forced break boundary correctness', () => {
  it('every cursor position renders the correct character via right arrow', () => {
    const text = '你好世界测试';
    const wrapped = wrapText(text, 8); // "你好世界" | "测试"
    for (let c = 0; c < text.length; c++) {
      const pos = findCursorInWrappedLines(wrapped, c);
      const renderedChar = wrapped[pos.line]!.line[pos.col];
      expect(renderedChar, `cursor=${c} should be '${text[c]}' but got '${renderedChar}'`).toBe(text[c]);
    }
  });

  it('cursor at text.length maps to end of last line', () => {
    const text = '你好世界测试';
    const wrapped = wrapText(text, 8);
    const pos = findCursorInWrappedLines(wrapped, text.length);
    expect(pos.line).toBe(wrapped.length - 1);
    expect(pos.col).toBe(wrapped[wrapped.length - 1]!.line.length);
  });

  it('down arrow from any position on line 0 lands on line 1', () => {
    const text = '你好世界测试文字十个'; // 10 CJK chars
    const wrapped = wrapText(text, 8); // 4 | 4 | 2
    expect(wrapped.length).toBe(3);
    // From every position on line 0, pressing down should land on line 1
    for (let col = 0; col < wrapped[0]!.line.length; col++) {
      // Compute absolute cursor for this position on line 0
      const absCursor = col;
      const pos = findCursorInWrappedLines(wrapped, absCursor);
      expect(pos.line).toBe(0);
      // Simulate down arrow
      const targetLine = 1;
      let absolutePos = wrapped[0]!.line.length + wrapped[0]!.gapSize;
      // Cap targetCol for forced-break target lines
      let targetCol = col;
      if (wrapped[targetLine]!.gapSize === 0 && targetLine < wrapped.length - 1) {
        targetCol = Math.min(targetCol, wrapped[targetLine]!.line.length - 1);
      }
      absolutePos += targetCol;
      const newPos = findCursorInWrappedLines(wrapped, absolutePos);
      expect(newPos.line, `down from col=${col} should land on line 1`).toBe(1);
    }
  });

  it('down+up returns to the same line', () => {
    const text = '你好世界测试';
    const wrapped = wrapText(text, 8);
    const startCursor = 2;
    // Down
    const downAbs = wrapped[0]!.line.length + wrapped[0]!.gapSize + Math.min(2, wrapped[1]!.line.length);
    const downPos = findCursorInWrappedLines(wrapped, Math.min(downAbs, text.length));
    expect(downPos.line).toBe(1);
    // Up
    let upAbs = 0;
    const upTargetCol = Math.min(downPos.col, wrapped[0]!.line.length - 1); // cap for forced break
    upAbs += upTargetCol;
    const upPos = findCursorInWrappedLines(wrapped, upAbs);
    expect(upPos.line).toBe(0);
  });

  it('all characters in mixed CJK+ASCII text are reachable', () => {
    const text = '你好世界abcdefghij测试';
    const wrapped = wrapText(text, 10);
    for (let c = 0; c < text.length; c++) {
      const pos = findCursorInWrappedLines(wrapped, c);
      const renderedChar = wrapped[pos.line]!.line[pos.col];
      expect(renderedChar, `cursor=${c} should be '${text[c]}' but got '${renderedChar}'`).toBe(text[c]);
    }
  });

  it('space break boundary still works correctly', () => {
    const text = 'hello world test';
    const wrapped = wrapText(text, 10);
    // Every character should be reachable
    for (let c = 0; c < text.length; c++) {
      // Skip gap characters (spaces consumed at break points)
      const pos = findCursorInWrappedLines(wrapped, c);
      const line = wrapped[pos.line]!.line;
      if (pos.col < line.length) {
        // Character is within the line content
        expect(line[pos.col]).toBe(text[c]);
      }
    }
  });

  it('hard break (newline) boundary works correctly', () => {
    const text = '你好\n世界';
    const wrapped = wrapText(text, 20);
    expect(wrapped.length).toBe(2);
    // cursor=0 -> '你', cursor=1 -> '好'
    expect(wrapped[findCursorInWrappedLines(wrapped, 0).line]!.line[findCursorInWrappedLines(wrapped, 0).col]).toBe('你');
    expect(wrapped[findCursorInWrappedLines(wrapped, 1).line]!.line[findCursorInWrappedLines(wrapped, 1).col]).toBe('好');
    // cursor=2 -> newline, maps to end of line 0
    const pos2 = findCursorInWrappedLines(wrapped, 2);
    expect(pos2.line).toBe(0);
    expect(pos2.col).toBe(2); // past end, cursor shows as space
    // cursor=3 -> '世'
    const pos3 = findCursorInWrappedLines(wrapped, 3);
    expect(pos3.line).toBe(1);
    expect(pos3.col).toBe(0);
  });
});
