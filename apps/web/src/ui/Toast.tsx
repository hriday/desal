import { useEffect } from 'react';
import type { Toast as ToastState } from '../state/store';
import './toast.css';

const SHOW_MS = 6000;

/** The store's toast (e.g. a rejected command with its reason). Dismisses itself after a few seconds. */
export function Toast({ toast, onDismiss }: { toast: ToastState | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, SHOW_MS);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);
  if (!toast) return null;
  const title = toast.kind === 'rejected' ? 'Command rejected' : toast.kind === 'capacity' ? 'At capacity' : 'Error';
  return (
    <div className={`toast toast--${toast.kind}`} role="alert">
      <strong>{title}:</strong> {toast.message}
      <button type="button" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}
