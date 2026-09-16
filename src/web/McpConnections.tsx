import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Modal } from "./Modal.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
type Connection = {
  id: string;
  name: string;
  kind: string;
  scopes: string[];
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};
const time = (value: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
export function McpConnections() {
  const [connections, setConnections] = useState<Connection[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [confirm, setConfirm] = useState<Connection | null>(null);
  const refresh = async () =>
    setConnections(
      (await api<{ keys: Connection[] }>("/agent-keys")).keys.filter(
        (key) => key.kind === "mcp" && !key.revokedAt,
      ),
    );
  useEffect(() => {
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  return (
    <Modal title="MCP 연결" onClose={() => {}} busy={busy}>
      <label>
        MCP 서버 주소
        <input
          aria-label="MCP 서버 주소"
          readOnly
          value={`${location.origin}/mcp`}
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
      <p>
        ChatGPT에서 OAuth · DCR로 연결하고 본인 Google 계정으로 승인하세요.
        Client ID와 Secret은 비워 둡니다.
      </p>
      <p>
        연결은 별도 만료일 없이 유지됩니다. 아래에서 폐기하면 즉시 접근이
        차단되며, 다시 사용하려면 새로 연결해야 합니다. 접근 토큰은 보안을 위해
        자동 갱신됩니다.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">연결을 불러오는 중…</p>
      ) : !connections.length ? (
        <p>연결된 MCP가 없습니다.</p>
      ) : (
        connections.map((connection) => (
          <article className="session-card" key={connection.id}>
            <h4>{connection.name} · 연결됨</h4>
            <p>
              유효기한 없음 · 연결: {time(connection.createdAt)}
              <br />
              최근 사용:{" "}
              {connection.lastUsedAt
                ? time(connection.lastUsedAt)
                : "아직 없음"}
            </p>
            <p>
              {connection.scopes
                .map(
                  (s) =>
                    ({
                      "items:read": "읽기",
                      "items:write": "생성·수정·복구",
                      "items:delete": "삭제",
                    })[s] || s,
                )
                .join(" · ")}
            </p>
            <button disabled={busy} onClick={() => setConfirm(connection)}>
              연결 폐기
            </button>
          </article>
        ))
      )}
      {confirm && (
        <ConfirmDialog
          title="연결을 폐기할까요?"
          danger
          busy={busy}
          confirmLabel="폐기하기"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setBusy(true);
            setError("");
            try {
              await api(`/agent-keys/${confirm.id}/revoke`, {});
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
            ‘{confirm.name}’ 연결을 폐기할까요? 일정은 삭제되지 않으며, 접근만
            즉시 차단합니다. 이 작업은 취소 버튼으로 되돌릴 수 없습니다.
          </p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}
