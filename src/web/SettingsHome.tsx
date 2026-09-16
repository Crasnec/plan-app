import { useMemo, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Modal.js";
import { SettingsContext } from "./SettingsContext.js";
import { AgentKeys } from "./AgentKeys.js";
import { Sessions } from "./Sessions.js";
import { McpConnections } from "./McpConnections.js";
import { Invites } from "./Invites.js";
import type { Me } from "./api.js";
import { validPreferences, type Preferences } from "../shared/preferences.js";
const menus = [
  ["general", "기본 설정"],
  ["share", "공유 링크"],
  ["notifications", "알림 설정"],
  ["sessions", "세션 관리"],
  ["mcp", "MCP 연결"],
  ["keys", "API 키 관리"],
  ["invites", "초대"],
  ["account", "계정"],
] as const;
type Tab = (typeof menus)[number][0];
export function SettingsHome({
  me,
  onClose,
  onLogout,
  preferences,
  onSave,
  renderPanel,
}: {
  me: Me;
  onClose: () => void;
  onLogout: () => Promise<void>;
  preferences: Preferences;
  onSave: (value: Preferences) => Promise<void>;
  renderPanel: (panel: "share" | "notifications") => ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("general"),
    [draft, setDraft] = useState({ ...preferences }),
    [saved, setSaved] = useState({ ...preferences });
  const [busy, setBusy] = useState(false),
    [childBusy, setChildBusy] = useState(false),
    [error, setError] = useState("");
  const guard = useRef<() => boolean>(() => true);
  const context = useMemo(() => ({ guard, setBusy: setChildBusy }), []);
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  const leave = () => {
    if (!busy && !childBusy && guard.current()) onClose();
  };
  const save = async (close: boolean) => {
    if (busy || childBusy || !guard.current()) return;
    if (changed && !validPreferences(draft)) {
      setError("기본 소요 시간은 5~1440분으로 입력해 주세요.");
      setTab("general");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (changed) {
        await onSave(draft);
        setSaved({ ...draft });
      }
      if (close) onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="설정"
      onClose={leave}
      busy={busy || childBusy}
      wide
      className="settings-dialog"
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="설정 메뉴">
          {menus.map(([id, title]) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              disabled={busy || childBusy}
              onClick={() => {
                if (guard.current()) setTab(id);
              }}
            >
              {title}
            </button>
          ))}
        </nav>
        <div className="settings-pane" key={tab}>
          <SettingsContext.Provider value={context}>
            {tab === "general" && (
              <section aria-label="기본 설정">
                <h3>기본 설정</h3>
                <label>
                  기본 소요 시간 (분)
                  <input
                    aria-label="기본 소요 시간 (분)"
                    type="number"
                    min={5}
                    max={1440}
                    step={1}
                    value={draft.durationMinutes || ""}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        durationMinutes: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  완료 일정
                  <select
                    aria-label="완료 일정"
                    value={String(draft.showCompleted)}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        showCompleted: e.target.value === "true",
                      })
                    }
                  >
                    <option value="true">표시</option>
                    <option value="false">숨기기</option>
                  </select>
                </label>
                <label>
                  새 일정의 공유 공개 기본값
                  <select
                    aria-label="새 일정의 공유 공개 기본값"
                    value={String(draft.publicByDefault)}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        publicByDefault: e.target.value === "true",
                      })
                    }
                  >
                    <option value="false">비공개</option>
                    <option value="true">공개</option>
                  </select>
                </label>
                <label>
                  API 새 일정에도 기본값 적용
                  <select
                    aria-label="API 새 일정에도 기본값 적용"
                    value={String(draft.applyToApi)}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        applyToApi: e.target.value === "true",
                      })
                    }
                  >
                    <option value="false">적용 안 함</option>
                    <option value="true">적용</option>
                  </select>
                </label>
                <p className="muted">
                  기본값은 새 일정에만 사용하며 기존 일정은 바뀌지 않습니다.
                  API·MCP 적용 시 직접 지정한 값을 우선합니다. 완료 숨기기는 내
                  달력·목록에만 적용됩니다.
                </p>
              </section>
            )}
            {(tab === "share" || tab === "notifications") && renderPanel(tab)}
            {tab === "keys" && <AgentKeys onClose={leave} />}
            {tab === "sessions" && (
              <Sessions onClose={leave} onBack={() => setTab("general")} />
            )}
            {tab === "mcp" && <McpConnections />}
            {tab === "invites" && <Invites />}
            {tab === "account" && (
              <section>
                <h3>계정</h3>
                <p>
                  {me.demo
                    ? "로컬 데모 · Google 로그인 없음"
                    : (me.email ?? "로그인됨")}
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
                    로그아웃
                  </button>
                )}
              </section>
            )}
          </SettingsContext.Provider>
        </div>
      </div>
      <footer className="settings-footer">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="field-hint">
          {changed ? "저장하지 않은 기본 설정이 있습니다. " : ""}링크·키 발급,
          연결 폐기, 로그아웃, 알림 권한은 각 버튼을 누르면 즉시 처리됩니다.
        </p>
        <div className="settings-footer-actions">
          <button disabled={busy || childBusy} onClick={leave}>
            취소
          </button>
          <button
            disabled={busy || childBusy || !changed}
            onClick={() => void save(false)}
          >
            적용
          </button>
          <button
            className="primary"
            disabled={busy || childBusy}
            onClick={() => void save(true)}
          >
            확인
          </button>
        </div>
      </footer>
    </Modal>
  );
}
