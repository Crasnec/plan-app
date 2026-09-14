import { useState } from "react";
import { Modal } from "./Modal.js";
import { Icon } from "./icons.js";
import type { Me } from "./api.js";

export function SettingsHome({
  me,
  onClose,
  onOpen,
  onLogout,
}: {
  me: Me;
  onClose: () => void;
  onOpen: (panel: "share" | "notifications" | "keys") => void;
  onLogout: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="설정" onClose={onClose} busy={busy}>
      <div className="settings-content settings-home">
        <p className="muted">
          공유, 알림과 에이전트 연결을 한곳에서 관리하세요.
        </p>
        <nav className="settings-menu" aria-label="설정 항목">
          {(
            [
              ["share", "link", "공유 링크", "공개 일정의 읽기 전용 링크 관리"],
              [
                "notifications",
                "bell",
                "알림 설정",
                "이 기기의 일정 알림 켜기·끄기",
              ],
              [
                "keys",
                "lock",
                "API 키 관리",
                "에이전트 키 발급·권한 확인·폐기",
              ],
            ] as const
          ).map(([panel, icon, title, description]) => (
            <button
              key={panel}
              disabled={busy}
              onClick={() => onOpen(panel)}
              aria-label={title}
            >
              <Icon name={icon} />
              <span>
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
              <Icon name="right" size={16} />
            </button>
          ))}
        </nav>
        <section
          className="settings-account"
          aria-labelledby="settings-account-title"
        >
          <h3 id="settings-account-title">계정</h3>
          <p>
            {me.demo
              ? "로컬 데모 · Google 로그인 없음"
              : me.email || "소유자 계정으로 로그인됨"}
          </p>
          {!me.demo && (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await onLogout();
                } catch (e) {
                  setError((e as Error).message);
                  setBusy(false);
                }
              }}
            >
              <Icon name="logout" size={16} /> 로그아웃
            </button>
          )}
        </section>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
