import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Me } from "./api.js";
import { Icon } from "./icons.js";
import { Calendar, range, type View } from "./Calendar.js";
import { Editor } from "./Editor.js";
import { Modal } from "./Modal.js";
import {
  today,
  addDays,
  local,
  startDate,
  endDate,
  validDate,
  type Occurrence,
  type Fields,
  type Scope,
} from "../shared/domain.js";
import "./style.css";
const weekdays = [
  "일요일",
  "월요일",
  "화요일",
  "수요일",
  "목요일",
  "금요일",
  "토요일",
];
function App() {
  const shared = location.pathname.startsWith("/s/")
    ? location.pathname.split("/")[2]
    : null;
  const initial = new URLSearchParams(location.search).get("date");
  const [me, setMe] = useState<Me | null>(null),
    [date, setDate] = useState(
      initial && validDate(initial) ? initial : today(),
    ),
    [selected, setSelected] = useState(
      initial && validDate(initial) ? initial : today(),
    );
  const [view, setView] = useState<View>("month"),
    [events, setEvents] = useState<Occurrence[]>([]),
    [filter, setFilter] = useState("all"),
    [undated, setUndated] = useState(false);
  const [editor, setEditor] = useState<{
      event: Occurrence | null;
      date: string | null;
    } | null>(null),
    [panel, setPanel] = useState<"share" | "trash" | "notifications" | null>(
      null,
    );
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [notice, setNotice] = useState(""),
    [online, setOnline] = useState(navigator.onLine);
  const [moving, setMoving] = useState<{
      event: Occurrence;
      start: string;
      end: string;
    } | null>(null),
    [moveScope, setMoveScope] = useState<Scope>("one"),
    [savingMove, setSavingMove] = useState(false);
  const readOnly = !!shared || !me?.owner;
  const loadSequence = useRef(0);
  useEffect(() => {
    api<Me>("/me")
      .then(setMe)
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);
  const load = useCallback(async () => {
    if (!me || (!me.owner && !shared)) {
      setLoading(false);
      return;
    }
    const r = range(date, view);
    const sequence = ++loadSequence.current;
    try {
      const data = await api<Occurrence[]>(
        `/items?from=${r.from}&to=${r.to}${shared ? `&share=${encodeURIComponent(shared)}` : ""}`,
      );
      if (sequence !== loadSequence.current) return;
      setEvents(data);
      setError("");
    } catch (e) {
      if (sequence !== loadSequence.current) return;
      setError((e as Error).message);
      if ([401, 404].includes((e as { status: number }).status)) {
        setEvents([]);
        setEditor(null);
      }
      if ((e as { status: number }).status === 401 && !shared)
        setMe((x) => (x ? { ...x, owner: false } : x));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [date, view, shared, me]);
  useEffect(() => {
    setLoading(true);
    void load();
    return () => {
      ++loadSequence.current;
    };
  }, [load]);
  useEffect(() => {
    if (!me?.owner && !shared) return;
    let sse: EventSource | undefined;
    if (!shared) {
      sse = new EventSource("/api/events");
      sse.addEventListener("change", () => void load());
      sse.addEventListener("ready", () => void load());
    }
    const timer = setInterval(
      () => {
        if (document.visibilityState === "visible") void load();
      },
      shared ? 15000 : 60000,
    );
    const focus = () => {
      if (document.visibilityState === "visible") void load();
    };
    const connection = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void load();
    };
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    return () => {
      sse?.close();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
    };
  }, [load, me, shared]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const filtered = events.filter(
    (e) => filter === "all" || (filter === "done" ? e.done : !e.done),
  );
  const list = filtered.filter((e) =>
    undated
      ? e.kind === "undated"
      : e.kind !== "undated" &&
        startDate(e)! <= selected &&
        endDate(e)! >= selected,
  );
  const dayEvents = events.filter(
    (e) =>
      e.kind !== "undated" &&
      startDate(e)! <= selected &&
      endDate(e)! >= selected,
  );
  const complete = dayEvents.filter((e) => e.done).length;
  const undatedCount = events.filter((e) => e.kind === "undated").length;
  const select = (d: string) => {
    setSelected(d);
    setUndated(false);
  };
  async function change(
    event: Occurrence,
    fields: Fields,
    scope: Scope,
    deleting = false,
  ) {
    await api(`/items/${event.itemId}/change`, {
      key: event.key,
      version: event.version,
      scope,
      fields,
      deleting,
    });
    await load();
  }
  async function completeEvent(e: Occurrence) {
    try {
      await change(e, { ...e, done: !e.done }, "one");
    } catch (err) {
      await load();
      setError((err as Error).message);
    }
  }
  function navigate(n: number) {
    const d = new Date(`${date}T12:00:00Z`);
    if (view === "month") {
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + n);
    } else d.setUTCDate(d.getUTCDate() + n * (view === "week" ? 7 : 1));
    const next = d.toISOString().slice(0, 10);
    setDate(next);
    setSelected(next);
  }
  async function move(
    event: Occurrence,
    start: string,
    end: string,
    scope: Scope,
  ) {
    await change(event, { ...event, start, end }, scope);
    setNotice("일정을 옮겼습니다.");
  }
  function onMove(event: Occurrence, start: string, end: string) {
    if (event.recurring) {
      setMoveScope("one");
      setMoving({ event, start, end });
    } else
      void move(event, start, end, "one").catch((e) => setError(e.message));
  }
  async function logout() {
    await api("/logout", {});
    location.assign("/");
  }
  if (!me)
    return (
      <div className="loading-screen">
        <Icon name="leaf" size={36} />
        <p>{error || "오늘의 계획을 준비하고 있어요…"}</p>
        {error && <button onClick={() => location.reload()}>다시 시도</button>}
      </div>
    );
  if (!me.owner && !shared)
    return (
      <main className="login-page">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="leaf" size={28} />
          </span>
          하루의 계획
        </div>
        <div className="login-card">
          <span className="eyebrow">조금 더 가벼운 하루</span>
          <h1>
            해야 할 일도,
            <br />
            하고 싶은 일도.
          </h1>
          <p>
            나만의 속도로 하루를 채워 보세요.
            <br />
            모든 계획을 한곳에서 차분하게.
          </p>
          <a className="primary login-button" href="/auth/google">
            Google로 시작하기 <Icon name="right" />
          </a>
          {!me.loginReady && (
            <p className="field-hint">
              로그인 연결을 준비 중입니다. 서버에 Google 인증 설정을 추가하면
              사용할 수 있습니다.
            </p>
          )}
          <span className="login-note">
            <Icon name="lock" size={14} />
            소유자만 로그인할 수 있습니다.
          </span>
        </div>
        <footer>작은 계획이 모여, 나다운 하루.</footer>
      </main>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Icon name="leaf" size={24} />
          </span>
          <span>
            하루의 계획<small>나만의 속도로, 차근차근</small>
          </span>
        </a>
        <span className="nav-label">MY SPACE</span>
        <nav>
          <button
            className={!undated ? "active" : ""}
            onClick={() => setUndated(false)}
          >
            <Icon name="calendar" />내 달력
          </button>
          <button
            className={undated ? "active" : ""}
            onClick={() => setUndated(true)}
          >
            <Icon name="list" />
            날짜 미정<span className="count">{undatedCount}</span>
          </button>
        </nav>
        <div className="sidebar-note">
          <Icon name="leaf" size={32} />
          <p>
            빽빽하지 않아도 괜찮아요.
            <br />
            오늘은 오늘의 속도로.
          </p>
        </div>
        <div className="sidebar-bottom">
          {!readOnly && (
            <>
              <button onClick={() => setPanel("share")}>
                <Icon name="link" />
                공유 링크
              </button>
              <button onClick={() => setPanel("notifications")}>
                <Icon name="bell" />
                알림 설정
              </button>
              <button onClick={() => setPanel("trash")}>
                <Icon name="trash" />
                휴지통
              </button>
            </>
          )}
          <div className="profile">
            <span className="avatar">{shared ? "V" : "C"}</span>
            <div>
              {shared ? "함께 보는 계획" : "나의 공간"}
              <small>
                {shared ? "읽기 전용" : me.demo ? "로컬 미리보기" : "개인 일정"}
              </small>
            </div>
            {!readOnly && !me.demo && (
              <button aria-label="로그아웃" onClick={() => void logout()}>
                <Icon name="logout" size={18} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="page-heading">
          <div>
            <span className="eyebrow">
              {shared ? "SHARED CALENDAR" : "A LITTLE PLAN, A BETTER DAY"}
            </span>
            <h1>{shared ? "함께 보는 계획" : "오늘도, 차근차근"}</h1>
            <p>
              {shared
                ? "공개된 일정을 편하게 둘러보세요."
                : "작은 할 일부터, 나다운 하루를 만들어 보세요."}
            </p>
          </div>
          <div className="header-actions">
            {!readOnly && (
              <>
                <button
                  className="mobile-settings icon-button"
                  aria-label="공유 및 설정"
                  onClick={() => setPanel("share")}
                >
                  <Icon name="link" />
                </button>
                <button
                  className="primary"
                  onClick={() =>
                    setEditor({ event: null, date: undated ? null : selected })
                  }
                >
                  <Icon name="plus" />
                  <span>새 할 일</span>
                </button>
              </>
            )}
            {shared && (
              <span className="readonly-badge">
                <Icon name="lock" size={14} />
                읽기 전용
              </span>
            )}
          </div>
        </header>
        {me.demo && !shared && (
          <div className="demo-banner">
            로컬 미리보기 · 일정은 이 환경의 데모 데이터베이스에 저장됩니다.
          </div>
        )}
        {!online && (
          <div className="error" role="status">
            인터넷 연결이 끊겼습니다. 연결 후 최신 일정을 불러옵니다.
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => void load()}>다시 불러오기</button>
          </div>
        )}
        <div className="mobile-nav">
          <button
            className={!undated ? "active" : ""}
            onClick={() => setUndated(false)}
          >
            달력
          </button>
          <button
            className={undated ? "active" : ""}
            onClick={() => setUndated(true)}
          >
            날짜 미정 {undatedCount}
          </button>
          {!readOnly && (
            <>
              <button
                onClick={() => setPanel("notifications")}
                aria-label="알림"
              >
                <Icon name="bell" size={18} />
              </button>
              <button onClick={() => setPanel("trash")} aria-label="휴지통">
                <Icon name="trash" size={18} />
              </button>
            </>
          )}
        </div>
        <div className="workspace">
          <section className="calendar-card" aria-label="달력">
            <div className="calendar-toolbar">
              <div className="calendar-title">
                <h2>
                  {Number(date.slice(0, 4))}년 {Number(date.slice(5, 7))}월
                </h2>
                <div className="period-buttons">
                  <button
                    className="icon-button"
                    aria-label="이전 기간"
                    onClick={() => navigate(-1)}
                  >
                    <Icon name="left" size={18} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="다음 기간"
                    onClick={() => navigate(1)}
                  >
                    <Icon name="right" size={18} />
                  </button>
                </div>
                <button
                  className="today-button"
                  onClick={() => {
                    setDate(today());
                    select(today());
                  }}
                >
                  오늘
                </button>
              </div>
              <div className="view-switch">
                {(
                  [
                    ["month", "월"],
                    ["week", "주"],
                    ["day", "일"],
                  ] as const
                ).map(([v, t]) => (
                  <button
                    key={v}
                    aria-pressed={view === v}
                    className={view === v ? "active" : ""}
                    onClick={() => {
                      setView(v);
                      setDate(selected);
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <Calendar
              date={date}
              selected={selected}
              view={view}
              events={filtered}
              onSelect={select}
              onOpen={(event) => setEditor({ event, date: selected })}
              onMove={onMove}
              readOnly={readOnly || !online}
            />
            <footer className="calendar-footer">
              <span>
                <i />
                예정된 할 일
              </span>
              <span>
                <i className="completed-dot" />
                완료
              </span>
              <span className="timezone">한국 시간 · 월요일 시작</span>
            </footer>
          </section>
          <aside className="agenda">
            <div className="agenda-heading">
              <span className="eyebrow">
                {undated ? "SOMEDAY" : "YOUR DAY"}
              </span>
              <h2>
                {undated
                  ? "날짜 미정"
                  : `${Number(selected.slice(5, 7))}월 ${Number(selected.slice(8))}일`}
                <small>
                  {undated
                    ? "천천히 정해도 괜찮아요"
                    : weekdays[new Date(`${selected}T12:00:00Z`).getUTCDay()]}
                </small>
              </h2>
            </div>
            {!undated && (
              <div className="progress-card">
                <div>
                  <span>오늘의 작은 성취</span>
                  <strong>
                    {complete}
                    <small> / {dayEvents.length}</small>
                  </strong>
                </div>
                <div className="progress-track">
                  <span
                    style={{
                      width: `${dayEvents.length ? (complete / dayEvents.length) * 100 : 0}%`,
                    }}
                  />
                </div>
                <p>
                  {complete && complete === dayEvents.length
                    ? "오늘의 계획을 모두 마쳤어요. 수고했어요!"
                    : "하나씩 해내는 것만으로 충분해요."}
                </p>
              </div>
            )}
            <div className="filter-tabs" aria-label="완료 상태 필터">
              {[
                ["all", "전체"],
                ["pending", "진행 중"],
                ["done", "완료"],
              ].map(([v, t]) => (
                <button
                  key={v}
                  aria-pressed={filter === v}
                  className={filter === v ? "active" : ""}
                  onClick={() => setFilter(v)}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="task-list" aria-busy={loading}>
              {list.length ? (
                list.map((e) => (
                  <article
                    key={e.id}
                    className={`task-card ${e.done ? "done" : ""}`}
                  >
                    {!readOnly ? (
                      <button
                        disabled={!online}
                        className={`checkbox ${e.done ? "checked" : ""}`}
                        role="checkbox"
                        aria-checked={e.done}
                        aria-label={`${e.title} 완료 표시`}
                        onClick={() => void completeEvent(e)}
                      >
                        {e.done && <Icon name="check" size={16} />}
                      </button>
                    ) : (
                      <span className={`checkbox ${e.done ? "checked" : ""}`}>
                        {e.done && <Icon name="check" size={16} />}
                      </span>
                    )}
                    <button
                      className="task-content"
                      onClick={() => setEditor({ event: e, date: selected })}
                    >
                      <strong>{e.title}</strong>
                      <span>
                        {e.kind === "undated"
                          ? "날짜 미정"
                          : e.kind === "all_day"
                            ? "종일"
                            : `${local(e.start!).slice(11, 16)} – ${local(e.end!).slice(11, 16)}`}
                        {e.recurring && <Icon name="repeat" size={13} />}
                        <span className="visibility">
                          {e.public ? "공개" : "나만 보기"}
                        </span>
                      </span>
                      {e.notes && <p>{e.notes}</p>}
                    </button>
                  </article>
                ))
              ) : (
                <div className="empty-state">
                  <Icon name="leaf" size={38} />
                  <h3>
                    {loading ? "일정을 불러오고 있어요" : "여백이 있는 하루"}
                  </h3>
                  <p>
                    {filter !== "all"
                      ? "이 상태의 할 일이 없습니다."
                      : undated
                        ? "아직 날짜 미정인 할 일이 없어요."
                        : "아직 등록된 할 일이 없어요."}
                  </p>
                  {!readOnly && (
                    <button
                      onClick={() =>
                        setEditor({
                          event: null,
                          date: undated ? null : selected,
                        })
                      }
                    >
                      작은 계획 하나 더하기
                    </button>
                  )}
                </div>
              )}
            </div>
            {!readOnly && list.length > 0 && (
              <button
                className="add-task"
                onClick={() =>
                  setEditor({ event: null, date: undated ? null : selected })
                }
              >
                <Icon name="plus" size={18} />할 일 추가하기
              </button>
            )}
          </aside>
        </div>
        <footer className="page-footer">
          작은 계획이 모여, 나다운 하루.
          <span>
            {shared
              ? "공개 일정은 자동으로 새로고침됩니다."
              : "변경 사항은 다른 기기에도 반영됩니다."}
          </span>
        </footer>
      </main>
      {editor && (
        <Editor
          key={editor.event?.id || "new"}
          {...editor}
          readOnly={readOnly}
          onClose={() => setEditor(null)}
          onSave={async (f, scope) => {
            if (editor.event) await change(editor.event, f, scope);
            else {
              await api("/items", f);
              await load();
            }
            setNotice("일정을 저장했습니다.");
          }}
          onDelete={async (scope) => {
            await change(editor.event!, editor.event!, scope, true);
            setNotice("휴지통으로 이동했습니다.");
          }}
        />
      )}
      {moving && (
        <Modal
          busy={savingMove}
          title="반복 일정 이동"
          onClose={() => {
            if (!savingMove) setMoving(null);
          }}
        >
          <p>어느 일정에 적용할까요?</p>
          <fieldset className="scope">
            {(
              [
                ["one", "이번만"],
                ["future", "이번부터 이후"],
                ["all", "전체"],
              ] as const
            ).map(([v, t]) => (
              <label key={v}>
                <input
                  type="radio"
                  name="moveScope"
                  checked={moveScope === v}
                  onChange={() => setMoveScope(v)}
                />
                {t}
              </label>
            ))}
          </fieldset>
          <button
            className="primary"
            disabled={savingMove}
            onClick={async () => {
              setSavingMove(true);
              try {
                await move(moving.event, moving.start, moving.end, moveScope);
                setMoving(null);
              } catch (e) {
                setError((e as Error).message);
                setMoving(null);
              } finally {
                setSavingMove(false);
              }
            }}
          >
            이동하기
          </button>
        </Modal>
      )}
      {panel && (
        <Settings
          panel={panel}
          me={me}
          onClose={() => setPanel(null)}
          onChange={load}
          notify={setNotice}
        />
      )}
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          {notice}
        </div>
      )}
    </div>
  );
}
function Settings({
  panel,
  me,
  onClose,
  onChange,
  notify,
}: {
  panel: "share" | "trash" | "notifications";
  me: Me;
  onClose: () => void;
  onChange: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [trash, setTrash] = useState<
      { id: string; title: string; deleted_at: number }[]
    >([]),
    [active, setActive] = useState(false),
    [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [subscribed, setSubscribed] = useState(false);
  useEffect(() => {
    if (panel === "trash")
      api<typeof trash>("/trash")
        .then(setTrash)
        .catch((e) => setError(e.message));
    if (panel === "share")
      api<{ active: boolean }>("/share")
        .then((x) => setActive(x.active))
        .catch((e) => setError(e.message));
    if (panel === "notifications" && "serviceWorker" in navigator)
      navigator.serviceWorker
        .getRegistration()
        .then((r) => r?.pushManager.getSubscription())
        .then((s) => setSubscribed(!!s))
        .catch(() => {});
  }, [panel]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function push() {
    if (
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    )
      throw new Error("이 브라우저는 푸시 알림을 지원하지 않습니다.");
    if (!me.pushKey) throw new Error("서버에 알림 키를 먼저 설정해 주세요.");
    if ((await Notification.requestPermission()) !== "granted")
      throw new Error("브라우저 설정에서 알림을 허용해 주세요.");
    await navigator.serviceWorker.register("/sw.js");
    const registration = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(
      atob(me.pushKey.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const subscription =
      (await registration.pushManager.getSubscription()) ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      }));
    await api("/push", subscription.toJSON());
    setSubscribed(true);
    notify("이 기기의 알림을 켰습니다.");
  }
  return (
    <Modal
      busy={busy}
      title={
        panel === "share"
          ? "공유 링크"
          : panel === "trash"
            ? "휴지통"
            : "알림 설정"
      }
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {panel === "share" ? (
        <div className="settings-content">
          <div className="setting-illustration">
            <Icon name="link" size={32} />
          </div>
          <h3>계획을 함께 나누세요.</h3>
          <p>
            공개로 설정한 일정만 보입니다. 링크를 받은 사람은 로그인 없이 볼 수
            있으며 수정할 수 없습니다.
          </p>
          <span className={`status-pill ${active ? "enabled" : ""}`}>
            {active ? "공유 링크 활성" : "공유 비활성"}
          </span>
          {url && (
            <label>
              공유 주소
              <input readOnly value={url} onFocus={(e) => e.target.select()} />
              <button
                onClick={() =>
                  void run(async () => {
                    await navigator.clipboard.writeText(url);
                    notify("링크를 복사했습니다.");
                  })
                }
              >
                링크 복사
              </button>
            </label>
          )}
          <div className="settings-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const data = await api<{ url: string }>("/share", {
                    action: "rotate",
                  });
                  setUrl(data.url);
                  setActive(true);
                })
              }
            >
              {active ? "새 링크 발급" : "공유 링크 만들기"}
            </button>
            {active && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api("/share", { action: "disable" });
                    setUrl("");
                    setActive(false);
                  })
                }
              >
                비활성화
              </button>
            )}
          </div>
          <p className="field-hint">
            새 링크를 발급하면 기존 링크는 즉시 만료됩니다. 발급한 주소는 복사해
            보관해 주세요.
          </p>
        </div>
      ) : panel === "trash" ? (
        <div className="settings-content">
          <p>삭제한 일정은 30일 동안 복구할 수 있습니다.</p>
          {trash.length ? (
            trash.map((t) => (
              <div className="trash-item" key={t.id}>
                <div>
                  <strong>{t.title}</strong>
                  <small>
                    {Math.max(
                      0,
                      30 - Math.floor((Date.now() - t.deleted_at) / 86400000),
                    )}
                    일 남음
                  </small>
                </div>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/trash/${t.id}/restore`, {});
                      setTrash(await api("/trash"));
                      await onChange();
                      notify("일정을 복구했습니다.");
                    })
                  }
                >
                  복구
                </button>
              </div>
            ))
          ) : (
            <div className="empty-state">
              <Icon name="trash" size={32} />
              <p>휴지통이 비어 있습니다.</p>
            </div>
          )}
        </div>
      ) : (
        <div className="settings-content">
          <div className="setting-illustration">
            <Icon name="bell" size={32} />
          </div>
          <h3>다가오는 일을 기억하도록.</h3>
          <p>
            이 기기에서 내 일정 알림을 받습니다. PC와 휴대폰에서 각각 켜 주세요.
          </p>
          <span className={`status-pill ${subscribed ? "enabled" : ""}`}>
            {subscribed ? "이 기기 알림 켜짐" : "이 기기 알림 꺼짐"}
          </span>
          <div className="settings-actions">
            <button
              className="primary"
              disabled={busy || !me.pushKey}
              onClick={() => void run(push)}
            >
              {subscribed ? "알림 연결 확인" : "이 기기 알림 켜기"}
            </button>
            {subscribed && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await navigator.serviceWorker.getRegistration();
                    const s = await r?.pushManager.getSubscription();
                    if (s) {
                      await api("/push/remove", { endpoint: s.endpoint });
                      await s.unsubscribe();
                    }
                    setSubscribed(false);
                  })
                }
              >
                알림 끄기
              </button>
            )}
          </div>
          {!me.pushKey && (
            <p className="field-hint">서버의 알림 연결을 준비 중입니다.</p>
          )}
          <p className="field-hint">
            시간 지정은 기본 10분 전, 종일 일정은 오전 9시에 알립니다. 브라우저
            알림 권한과 기기의 배터리 설정에 따라 수신이 달라질 수 있습니다.
          </p>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
