import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Modal } from "./Modal.js";
type Key = {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};
const date = (value: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
export function AgentKeys({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<Key[]>([]);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [name, setName] = useState(""),
    [days, setDays] = useState(90);
  const [write, setWrite] = useState(false),
    [remove, setRemove] = useState(false);
  const [issued, setIssued] = useState<(Key & { token: string }) | null>(null);
  const [saved, setSaved] = useState(false),
    [confirm, setConfirm] = useState<Key | null>(null);
  const refresh = async () =>
    setKeys((await api<{ keys: Key[] }>("/agent-keys")).keys);
  useEffect(() => {
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  const close = () => {
    if (issued && !saved) {
      setError(
        "키를 복사하거나 안전한 곳에 저장한 뒤 ‘안전하게 저장했습니다’를 선택해 주세요.",
      );
      return;
    }
    onClose();
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || issued) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const key = await api<Key & { token: string }>("/agent-keys", {
        name: name.trim(),
        expiresInDays: days,
        scopes: [
          "items:read",
          ...(write ? ["items:write"] : []),
          ...(remove ? ["items:delete"] : []),
        ],
      });
      const { token: _token, ...metadata } = key;
      setIssued(key);
      setSaved(false);
      setKeys((current) => [metadata, ...current]);
      setName("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/agent-keys/${encodeURIComponent(confirm.id)}/revoke`, {});
      setConfirm(null);
      setNotice(
        "키를 폐기했습니다. 이 키를 사용하는 에이전트는 더 이상 접근할 수 없습니다.",
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="API 키 관리" onClose={close} busy={busy}>
      <div className="settings-content agent-keys">
        <p>
          에이전트가 내 일정에 접근할 때 사용하는 키입니다. 읽기 권한에는{" "}
          <strong>비공개 일정과 메모도 포함</strong>됩니다. 신뢰하는
          에이전트에만 전달하세요.
        </p>
        <p className="field-hint">
          API 주소: <code>{location.origin}/api/agent/v1</code>
          <br />
          인증: Authorization: Bearer &lt;API 키&gt;
        </p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        {issued ? (
        <section className="issued-key" aria-label="키 발급 결과">
            <h3>키가 발급되었습니다</h3>
            <p>
              원문은 지금 한 번만 표시됩니다. 창을 닫으면 다시 볼 수 없습니다.
            </p>
            <label>
              발급된 API 키
              <input
                aria-label="발급된 API 키"
                readOnly
                autoComplete="off"
                spellCheck={false}
                value={issued.token}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(issued.token);
                  setNotice("키를 복사했습니다. 안전한 곳에 보관해 주세요.");
                } catch {
                  setError(
                    "자동 복사가 차단되었습니다. 위의 키를 선택해 직접 복사해 주세요.",
                  );
                }
              }}
            >
              키 복사
            </button>
            <label className="check-row">
              <input
                type="checkbox"
                checked={saved}
                onChange={(e) => setSaved(e.target.checked)}
              />
              안전하게 저장했습니다
            </label>
            <button
              className="primary"
              disabled={!saved}
              onClick={() => {
                setIssued(null);
                setSaved(false);
                setError("");
                setNotice("");
              }}
            >
              확인
            </button>
          </section>
        ) : (
          <form onSubmit={create}>
            <h3>새 키 발급</h3>
            <label>
              키 이름
              <input
                required
                maxLength={80}
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: 개인 일정 에이전트"
              />
            </label>
            <label>
              만료 기간 (일)
              <input
                type="number"
                min={1}
                max={365}
                required
                value={days}
                disabled={busy}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </label>
            <fieldset disabled={busy}>
              <legend>접근 권한</legend>
              <label className="check-row">
                <input type="checkbox" checked disabled />
                일정 읽기 (필수)
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={write}
                  onChange={(e) => setWrite(e.target.checked)}
                />
                일정 생성·수정·복구
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={remove}
                  onChange={(e) => setRemove(e.target.checked)}
                />
                일정 삭제
              </label>
            </fieldset>
            <button
              className="primary"
              disabled={busy || loading || !name.trim()}
            >
              API 키 발급
            </button>
          </form>
        )}
        <section aria-label="발급한 키 목록">
          <h3>발급한 키</h3>
          {loading ? (
            <p role="status">불러오는 중…</p>
          ) : keys.length === 0 ? (
            <p>아직 발급한 키가 없습니다.</p>
          ) : (
            keys.map((key) => {
              const state = key.revokedAt
                ? "폐기됨"
                : Date.parse(key.expiresAt) <= Date.now()
                  ? "만료됨"
                  : "사용 가능";
              return (
                <article className="agent-key-row" key={key.id}>
                  <h4>
                    {key.name} <small>{state}</small>
                  </h4>
                  <p>
                    {key.scopes
                      .map(
                        (s) =>
                          ({
                            "items:read": "읽기",
                            "items:write": "생성·수정·복구",
                            "items:delete": "삭제",
                          })[s] || s,
                      )
                      .join(" · ")}
                    <br />
                    만료: {date(key.expiresAt)} (한국 시간)
                    <br />
                    최근 사용:{" "}
                    {key.lastUsedAt ? date(key.lastUsedAt) : "아직 없음"}
                  </p>
                  {!key.revokedAt && (
                    <button
                      disabled={busy || !!issued}
                      onClick={() => setConfirm(key)}
                      aria-label={`${key.name} 키 폐기`}
                    >
                      폐기
                    </button>
                  )}
                </article>
              );
            })
          )}
        </section>
        {confirm && (
          <section
            className="issued-key"
            role="group"
            aria-label="키 폐기 확인"
          >
            <p>
              ‘{confirm.name}’ 키를 폐기할까요? 연결된 에이전트의 접근이 즉시
              중단되며 되돌릴 수 없습니다.
            </p>
            <div className="settings-actions">
              <button disabled={busy} onClick={() => setConfirm(null)}>
                취소
              </button>
              <button disabled={busy} onClick={() => void revoke()}>
                폐기하기
              </button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
