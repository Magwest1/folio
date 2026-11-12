import type { HomeToast } from "../hooks/useHomeActions.ts";

/** A polite live region: changes are announced and can be taken back. */
export function HomeToasts({ toasts, onDismiss }: { toasts: HomeToast[]; onDismiss: (key: number) => void }) {
  return (
    <div className="home-toasts" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.key} className={`home-toast${toast.reminder ? " is-reminder" : ""}`}>
          {toast.reminder ? (
            <span className="home-toast-text">
              <span className="home-toast-kicker">Reminder</span>
              <strong>{toast.message}</strong>
              {toast.reminder.detail && <small>{toast.reminder.detail}</small>}
            </span>
          ) : (
            <span>{toast.message}</span>
          )}
          {toast.reminder?.actions.map((item) => (
            <button
              key={item.label}
              type="button"
              className="home-link-button"
              onClick={() => {
                item.run();
                onDismiss(toast.key);
              }}
            >
              {item.label}
            </button>
          ))}
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
