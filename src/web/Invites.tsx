import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Modal } from "./Modal.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
type Invite = {
  id: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByEmail: string | null;
  revokedAt: string | null;
};
const time = (value: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
export function Invites() {
  const [invites, setInvites] = useState<Invite[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [issued, setIssued] = useState<{ url: string } | null>(null),
    [confirm, setConfirm] = useState<Invite | null>(null);
  const refresh = async () =>
    setInvites((await api<{ invites: Invite[] }>("/invites")).invites);
  useEffect(() => {
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  const status = (invite: Invite) =>
    invite.revokedAt
      ? "취소됨"
      : invite.usedAt
        ? "사용됨"
        : Date.parse(invite.expiresAt) <= Date.now()
          ? "만료됨"
          : "대기 중";
  return (
    <Modal title="초대" onClose={() => {}} busy={busy}>
      <p>
        초대 링크로 가입한 사람은 나와 완전히 독립된 자신만의 일정을 갖게
        됩니다. 링크는 7일간 유효하며 한 번만 사용할 수 있습니다.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {issued ? (
        <section className="issued-key" aria-label="초대 링크 발급 결과">
          <h3>초대 링크가 발급되었습니다</h3>
          <p>원문은 지금 한 번만 표시됩니다. 복사해 전달해 주세요.</p>
          <label>
            초대 링크
            <input
              aria-label="초대 링크"
              readOnly
              autoComplete="off"
              spellCheck={false}
              value={issued.url}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(issued.url);
                setNotice("링크를 복사했습니다.");
              } catch {
                setError(
                  "자동 복사가 차단되었습니다. 위의 링크를 선택해 직접 복사해 주세요.",
                );
              }
            }}
          >
            링크 복사
          </button>
          <button className="primary" onClick={() => setIssued(null)}>
            닫기
          </button>
        </section>
      ) : (
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            setNotice("");
            try {
              const data = await api<{ url: string }>("/invites", {});
              setIssued({ url: data.url });
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          새 초대 링크 만들기
        </button>
      )}
      {loading ? (
        <p role="status">불러오는 중…</p>
      ) : !invites.length ? (
        <p>아직 만든 초대가 없습니다.</p>
      ) : (
        invites.map((invite) => (
          <article className="session-card" key={invite.id}>
            <h4>초대 · {status(invite)}</h4>
            <p>
              만든 날짜: {time(invite.createdAt)}
              <br />
              {invite.usedAt
                ? `사용됨: ${time(invite.usedAt)}${invite.usedByEmail ? ` · ${invite.usedByEmail}` : ""}`
                : `만료: ${time(invite.expiresAt)}`}
            </p>
            {!invite.usedAt && !invite.revokedAt && (
              <button disabled={busy} onClick={() => setConfirm(invite)}>
                취소
              </button>
            )}
          </article>
        ))
      )}
      {confirm && (
        <ConfirmDialog
          title="초대를 취소할까요?"
          danger
          busy={busy}
          confirmLabel="취소하기"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setBusy(true);
            setError("");
            try {
              await api(`/invites/${confirm.id}/revoke`, {});
              setConfirm(null);
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            아직 사용되지 않은 초대를 취소할까요? 이 링크로는 더 이상 가입할
            수 없습니다.
          </p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}
