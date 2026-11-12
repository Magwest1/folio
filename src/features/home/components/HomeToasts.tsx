import type { HomeToast } from "../hooks/useHomeActions.ts";

/** A polite live region: changes are announced and can be taken back. */
export function HomeToasts({ toasts, onDismiss }: { toasts: HomeToast[]; onDismiss: (key: number) => void }) {
  return (
    <div className="home-toasts" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.key} className="home-toast">
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              type="button"
              className="home-link-button"
              onClick={() => {
                toast.undo?.();
                onDismiss(toast.key);
              }}
            >
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
