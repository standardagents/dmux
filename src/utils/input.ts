import stringWidth from 'string-width';

const graphemeSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

const getGraphemes = (str: string): string[] => (
  graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(str), ({ segment }) => segment)
    : Array.from(str)
);

// Find the UTF-16 string index where cumulative display width would exceed targetWidth.
// Returns the string index for the last whole grapheme that fits within targetWidth columns.
export const findCharIndexAtWidth = (str: string, targetWidth: number): number => {
  let width = 0;
  let stringIndex = 0;
  for (const grapheme of getGraphemes(str)) {
    const cw = stringWidth(grapheme);
    if (width + cw > targetWidth) return stringIndex;
    width += cw;
    stringIndex += grapheme.length;
  }
  return str.length;
};

export const preprocessPastedContent = (input: string): string => {
  let cleaned = input.replace(/\x1b\[[0-9;]*m/g, '');
  cleaned = cleaned.replace(/\x1b\[[\d;]*[A-Za-z]/g, '');
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const looksLikeCode = cleaned.match(/[{}\[\]]/) || cleaned.split('\n').some(line => line.startsWith('  ') || line.startsWith('\t'));
  if (looksLikeCode) return cleaned;

  const boxChars = /[╭╮╰╯│─┌┐└┘├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋]/g;
  cleaned = cleaned.replace(boxChars, '');

  let lines = cleaned.split('\n');
  lines = lines.map(line => {
    line = line.replace(/^[>$#]\s+/, '');
    return line.trim();
  });
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const unwrappedLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i];
    const nextLine = lines[i + 1];
    if (nextLine && currentLine.length > 0 && !currentLine.match(/[.!?;:,]$/) && nextLine[0] && nextLine[0] === nextLine[0].toLowerCase()) {
      unwrappedLines.push(currentLine + ' ' + nextLine);
      i++;
    } else {
      unwrappedLines.push(currentLine);
    }
  }
  return unwrappedLines.join('\n');
};

export interface WrappedLine {
  line: string;
  isHardBreak: boolean;
  /** Number of characters consumed at the break that don't belong to either line (0 or 1). */
  gapSize: number;
}

export const wrapText = (text: string, width: number): WrappedLine[] => {
  if (!text) return [{ line: '', isHardBreak: false, gapSize: 0 }];
  const hardLines = text.split('\n');
  const wrappedLines: WrappedLine[] = [];
  for (let i = 0; i < hardLines.length; i++) {
    const hardLine = hardLines[i]!;
    const isLastHardLine = i === hardLines.length - 1;
    if (stringWidth(hardLine) <= width) {
      wrappedLines.push({ line: hardLine, isHardBreak: !isLastHardLine, gapSize: !isLastHardLine ? 1 : 0 });
    } else {
      let remaining = hardLine;
      while (remaining.length > 0) {
        if (stringWidth(remaining) <= width) {
          wrappedLines.push({ line: remaining, isHardBreak: !isLastHardLine, gapSize: !isLastHardLine ? 1 : 0 });
          break;
        }
        // Find how many characters fit within the display width
        const maxCharIdx = findCharIndexAtWidth(remaining, width);
        // Try to break at a space within the fitting range
        let breakPoint = maxCharIdx;
        const lastSpace = remaining.lastIndexOf(' ', maxCharIdx - 1);
        if (lastSpace > 0) {
          breakPoint = lastSpace;
        } else {
          const firstSpace = remaining.indexOf(' ');
          if (firstSpace > 0 && firstSpace < maxCharIdx) breakPoint = firstSpace;
          else breakPoint = Math.max(1, maxCharIdx); // ensure at least 1 char progress
        }
        const segment = remaining.slice(0, breakPoint);
        const nextChar = remaining[breakPoint];
        const spaceBreak = nextChar === ' ';
        wrappedLines.push({ line: segment.trimEnd(), isHardBreak: false, gapSize: spaceBreak ? 1 : 0 });
        if (spaceBreak) remaining = remaining.slice(breakPoint + 1);
        else remaining = remaining.slice(breakPoint);
      }
    }
  }
  return wrappedLines;
};

export const findCursorInWrappedLines = (
  wrappedLines: WrappedLine[],
  absoluteCursor: number
) => {
  if (wrappedLines.length === 0) return { line: 0, col: 0 };
  let currentPos = 0;
  for (let lineIndex = 0; lineIndex < wrappedLines.length; lineIndex++) {
    const wrappedLine = wrappedLines[lineIndex]!;
    const lineLength = wrappedLine.line.length;
    const isLastLine = lineIndex === wrappedLines.length - 1;
    // For forced breaks (gapSize=0, not last line), cursor at the boundary
    // belongs to the NEXT line since no gap character was consumed.
    // For gap breaks (gapSize>0) or last line, cursor at boundary stays here.
    const endInclusive = wrappedLine.gapSize > 0 || isLastLine;
    if (endInclusive
      ? absoluteCursor <= currentPos + lineLength
      : absoluteCursor < currentPos + lineLength) {
      const colInLine = absoluteCursor - currentPos;
      return { line: lineIndex, col: Math.max(0, Math.min(colInLine, lineLength)) };
    }
    currentPos += lineLength + wrappedLine.gapSize;
  }
  const lastLine = wrappedLines[wrappedLines.length - 1];
  return { line: wrappedLines.length - 1, col: lastLine ? lastLine.line.length : 0 };
};
