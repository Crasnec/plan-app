import { useState } from "react";
import { Modal } from "./Modal.js";
import { Icon } from "./icons.js";
import type { Me } from "./api.js";
import type { Preferences } from "../shared/preferences.js";

export function SettingsHome({
  me,
  onClose,
  onOpen,
  onLogout,
  preferences,
  onSave,
}: {
  me: Me;
  onClose: () => void;
  onOpen: (panel: "share" | "notifications" | "keys" | "sessions") => void;
  onLogout: () => Promise<void>;
  preferences: Preferences;
  onSave: (value: Preferences) => Promise<void>;
}) {
  const [draft, setDraft] = useState(preferences);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="설정" onClose={onClose} busy={busy}>
      <div className="settings-content settings-home">
        <p className="muted">
          공유, 알림과 에이전트 연결을 한곳에서 관리하세요.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await onSave(draft);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy} className="preferences-fields">
            <legend>기본 설정</legend>
            <label>
              기본 소요 시간 (분)
              <input
                aria-label="기본 소요 시간 (분)"
                type="number"
                min={5}
                max={1440}
                step={1}
                required
                value={draft.durationMinutes || ""}
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
                onChange={(e) =>
                  setDraft({ ...draft, applyToApi: e.target.value === "true" })
                }
              >
                <option value="false">적용 안 함</option>
                <option value="true">적용</option>
              </select>
            </label>
            <p className="muted">
              서버에 저장되어 다른 기기에도 적용됩니다. 완료 일정 숨기기는 내
              달력·목록에만 적용됩니다. 소요 시간과 공개 기본값은 새 일정에만
              사용하며, 기존 일정은 바뀌지 않습니다.
            </p>
            <p className="muted">
              API 적용 시 생략된 공개 여부와 시간 지정 일정의 종료 시간을
              채웁니다. 요청에 지정한 값은 그대로 사용합니다. 공개 일정은 공유
              링크에서 제목과 메모를 볼 수 있습니다.
            </p>
            <button className="primary" type="submit">
              {busy ? "저장 중…" : "기본 설정 저장"}
            </button>
          </fieldset>
        </form>
        <section
          className="settings-account"
          aria-labelledby="mcp-settings-title"
        >
          <h3 id="mcp-settings-title">ChatGPT · MCP 연결</h3>
          <label>
            MCP 서버 주소
            <input
              aria-label="MCP 서버 주소"
              readOnly
              value={`${location.origin}/mcp`}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <p className="muted">
            ChatGPT 웹의 개발자 모드에서 이 주소를 추가하고 OAuth 인증·동적
            클라이언트 등록(DCR)을 선택하세요. 클라이언트 ID와 비밀번호는 직접
            입력하지 않습니다.
          </p>
          <p className="muted">
            Google 소유자 로그인 후 필요한 권한을 승인하세요. 연결은 30일간
            유효하며, 아래 API 키 관리에서 ‘MCP · ChatGPT’를 폐기하면 연결이
            해제됩니다.
          </p>
        </section>
        <nav className="settings-menu" aria-label="설정 항목">
          {(
            [
              ["share", "link", "공유 링크", "공개 일정의 읽기 전용 링크 관리"],
              ["sessions", "lock", "세션 관리", "로그인한 기기 확인·로그아웃"],
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
