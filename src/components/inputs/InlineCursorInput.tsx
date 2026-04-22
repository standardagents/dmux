import React, { useEffect, useRef, useState } from 'react';
import { Text, useInput } from 'ink';

interface InlineCursorInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
}

const InlineCursorInput: React.FC<InlineCursorInputProps> = ({
  value,
  onChange,
  placeholder = '',
  focus = false,
}) => {
  const [cursor, setCursor] = useState(value.length);
  const lastRawKeyRef = useRef<string>('');

  useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      if (!focus) return;
      lastRawKeyRef.current = chunk.toString();
    };

    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [focus]);

  useEffect(() => {
    setCursor((prev) => Math.max(0, Math.min(prev, value.length)));
  }, [value.length]);

  useInput((input, key) => {
    if (!focus) return;

    const rawKey = lastRawKeyRef.current;
    lastRawKeyRef.current = '';

    const isBackTab = input === '\u001b[Z' || (key.tab && key.shift);
    if (key.tab || isBackTab || key.upArrow || key.downArrow || key.escape || key.return) {
      // Parent popup owns field switching, list navigation, ESC behavior, and submit.
      return;
    }

    if (key.leftArrow) {
      setCursor((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.rightArrow) {
      setCursor((prev) => Math.min(value.length, prev + 1));
      return;
    }

    if (key.ctrl && input === 'a') {
      setCursor(0);
      return;
    }

    if (key.ctrl && input === 'e') {
      setCursor(value.length);
      return;
    }

    // Forward delete key (Delete) commonly arrives as ESC [ 3 ~.
    // Some terminals misreport Backspace as key.delete with an empty sequence,
    // so prefer raw key sequence detection when available.
    const isForwardDeleteSequence =
      rawKey === '\u001b[3~' ||
      rawKey === '\u001b[3;2~' ||
      rawKey === '\u001b[3;5~' ||
      rawKey === '\u001b[3;6~' ||
      input === '\u001b[3~' ||
      input === '\u001b[3;2~' ||
      input === '\u001b[3;5~' ||
      input === '\u001b[3;6~';

    const isBackspaceSequence =
      rawKey === '\x7f' ||
      rawKey === '\x08' ||
      input === '\x7f' ||
      input === '\x08';

    const isBackspace =
      key.backspace ||
      isBackspaceSequence ||
      (key.delete && !isForwardDeleteSequence && !isBackspaceSequence && input.length === 0);

    const isForwardDelete = isForwardDeleteSequence || (key.delete && !isBackspace);

    if (isForwardDelete) {
      if (cursor < value.length) {
        onChange(value.slice(0, cursor) + value.slice(cursor + 1));
      }
      return;
    }

    // Backspace deletes character to the left of cursor.
    if (isBackspace) {
      if (cursor > 0) {
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor((prev) => prev - 1);
      }
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      onChange(value.slice(0, cursor) + input + value.slice(cursor));
      setCursor((prev) => prev + input.length);
    }
  });

  if (!value.length) {
    if (!focus) {
      return <Text dimColor>{placeholder}</Text>;
    }

    return (
      <Text>
        <Text inverse> </Text>
        <Text dimColor>{placeholder}</Text>
      </Text>
    );
  }

  const before = value.slice(0, cursor);
  const atCursor = cursor < value.length ? value[cursor] : ' ';
  const after = cursor < value.length ? value.slice(cursor + 1) : '';

  return (
    <Text>
      {before}
      {focus ? <Text inverse>{atCursor}</Text> : atCursor}
      {after}
    </Text>
  );
};

export default InlineCursorInput;
