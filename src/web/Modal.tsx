import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { SettingsContext } from "./SettingsContext.js";
import { Icon } from "./icons.js";
type ModalProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  busy?: boolean;
  onBack?: () => void;
  canLeave?: () => boolean;
  className?: string;
};
export function Modal(props: ModalProps) {
  const context = useContext(SettingsContext);
  return context ? <EmbeddedPanel {...props} /> : <Dialog {...props} />;
}
function EmbeddedPanel({
  title,
  children,
  busy = false,
  canLeave,
}: ModalProps) {
  const context = useContext(SettingsContext)!;
  useLayoutEffect(() => {
    context.guard.current = () => !busy && (!canLeave || canLeave());
    context.setBusy(busy);
  });
  useLayoutEffect(
    () => () => {
      context.guard.current = () => true;
      context.setBusy(false);
    },
    [context],
  );
  return (
    <section className="settings-embedded" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function Dialog({
  title,
  onClose,
  children,
  wide = false,
  busy = false,
  onBack,
  className = "",
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`${wide ? "modal wide" : "modal"} ${className}`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-head">
        {onBack && (
          <button
            className="icon-button"
            aria-label="설정으로 돌아가기"
            onClick={onBack}
            disabled={busy}
          >
            <Icon name="left" />
          </button>
        )}
        <h2 id="modal-title">{title}</h2>
        <button
          className="icon-button"
          aria-label="닫기"
          onClick={onClose}
          disabled={busy}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
