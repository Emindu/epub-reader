// Browser replacements for the desktop shell's file dialog, clipboard and
// "open in browser" calls.

/**
 * Show the browser's file picker. Resolves with the chosen File, or null if
 * the user cancels. Must be called from a click handler (browsers block
 * programmatic pickers otherwise).
 */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';

    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    // Fired when the picker closes without a selection (Chrome 113+,
    // Firefox 91+, Safari 16.4+). Older engines just never resolve, which
    // leaves the modal's busy state harmlessly stuck until reload.
    input.addEventListener('cancel', () => finish(null));

    document.body.appendChild(input);
    input.click();
  });
}

export async function readClipboardText(): Promise<string> {
  return navigator.clipboard.readText();
}

export async function writeClipboardText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}
