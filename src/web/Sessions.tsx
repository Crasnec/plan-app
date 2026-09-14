import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Modal } from "./Modal.js";
type Session = {
  id: string;
  device: string;
  current: boolean;
  createdAt: string | null;
  lastSeenAt: string | null;
  expiresAt: string;
};
const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "기록 없음";
export function Sessions({
  onClose,
  onBack,
}: {
  onClose: () => void;
  onBack: () => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]),
    [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<Session | "others" | null>(null);
  const refresh = async () => {
    const data = await api<{ sessions: Session[]; demo: boolean }>("/sessions");
    setSessions(data.sessions);
    setDemo(data.demo);
  };
  useEffect(() => {
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  const others = sessions.filter((session) => !session.current);
  return (
    <Modal title="세션 관리" onClose={onClose} onBack={onBack} busy={busy}>
      <p className="muted">
        로그인한 브라우저별로 표시합니다. 같은 기기도 브라우저나 프로필이 다르면
        별도 세션입니다. 시간은 한국 시간 기준입니다.
      </p>
      <p className="muted">
        로그아웃해도 일정은 삭제되지 않습니다. API·MCP 연결은 설정의 API 키
        관리에서 별도로 폐기하세요.
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {confirm ? (
        <section className="session-confirm" aria-label="로그아웃 확인">
          <h3>
            {confirm === "others"
              ? "다른 기기를 모두 로그아웃할까요?"
              : confirm.current
                ? "이 기기를 로그아웃할까요?"
                : `${confirm.device}에서 로그아웃할까요?`}
          </h3>
          <p>
            {confirm === "others"
              ? "이 기기의 로그인은 유지됩니다."
              : confirm.current
                ? "현재 브라우저도 로그인 화면으로 돌아갑니다."
                : "해당 브라우저는 다시 로그인해야 사용할 수 있습니다."}
          </p>
          <div className="session-actions">
            <button disabled={busy} onClick={() => setConfirm(null)}>
              취소
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                setNotice("");
                try {
                  const result = await api<{ current: boolean }>(
                    confirm === "others"
                      ? "/sessions/revoke-others"
                      : `/sessions/${encodeURIComponent(confirm.id)}/revoke`,
                    {},
                  );
                  if (result.current) {
                    location.assign("/");
                    return;
                  }
                  setConfirm(null);
                  await refresh();
                  setNotice("선택한 세션을 로그아웃했습니다.");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "로그아웃 중…" : "로그아웃하기"}
            </button>
          </div>
        </section>
      ) : (
        <>
          <div className="session-actions">
            <button
              disabled={loading || busy}
              onClick={async () => {
                setLoading(true);
                setError("");
                try {
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setLoading(false);
                }
              }}
            >
              새로고침
            </button>
            <button
              disabled={loading || busy || !others.length}
              onClick={() => setConfirm("others")}
            >
              다른 기기 모두 로그아웃
            </button>
          </div>
          {loading ? (
            <p role="status">세션을 불러오는 중…</p>
          ) : demo ? (
            <p>로컬 데모에는 로그인 세션이 없습니다.</p>
          ) : !sessions.length ? (
            <p>활성 세션이 없습니다.</p>
          ) : (
            <div className="session-list">
              {sessions.map((session) => (
                <article className="session-card" key={session.id}>
                  <h3>
                    {session.device}{" "}
                    {session.current && (
                      <span className="current-session">이 기기</span>
                    )}
                  </h3>
                  <dl>
                    <dt>로그인</dt>
                    <dd>{time(session.createdAt)}</dd>
                    <dt>최근 사용</dt>
                    <dd>{time(session.lastSeenAt)}</dd>
                    <dt>만료</dt>
                    <dd>{time(session.expiresAt)}</dd>
                  </dl>
                  <button onClick={() => setConfirm(session)}>
                    {session.current ? "이 기기 로그아웃" : "로그아웃"}
                  </button>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
