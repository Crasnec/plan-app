import { useEffect, useRef, type ReactNode } from "react";
export function ConfirmDialog({
  title,
  children,
  confirmLabel = "확인",
  cancelLabel = "취소",
  danger = false,
  busy = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="confirm-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal-head">
        <h2 id="confirm-dialog-title">{title}</h2>
      </div>
      {children}
      <div className="settings-actions">
        <button disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          className={danger ? "danger" : "primary"}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
