import stringWidth from 'string-width';
import { SIDEBAR_WIDTH } from './layoutManager.js';

interface ToastLike {
  message: string;
}

export interface ToastSectionLayout {
  footerExtraLines: number;
  toastHeight: number;
}

export function getToastSectionLayout(
  currentToast: ToastLike | null | undefined,
  toastQueueLength: number,
  availableWidth: number = SIDEBAR_WIDTH - 2,
): ToastSectionLayout {
  if (currentToast) {
    const iconAndSpaceWidth = 2;
    const toastDisplayWidth = iconAndSpaceWidth + stringWidth(currentToast.message);
    const wrappedLines = Math.max(1, Math.ceil(toastDisplayWidth / availableWidth));

    return {
      footerExtraLines: wrappedLines + 2,
      toastHeight: wrappedLines + 1,
    };
  }

  if (toastQueueLength > 0) {
    return {
      footerExtraLines: 2,
      toastHeight: 1,
    };
  }

  return {
    footerExtraLines: 0,
    toastHeight: 0,
  };
}
