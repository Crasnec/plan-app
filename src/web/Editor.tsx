import { useState } from "react";
import { Modal } from "./Modal.js";
import { Icon } from "./icons.js";
import {
  addDays,
  defaultFields,
  local,
  toUTC,
  today,
  weekday,
  validate,
  type Fields,
  type Occurrence,
  type Rule,
  type Scope,
} from "../shared/domain.js";
const days = ["월", "화", "수", "목", "금", "토", "일"];
export function Editor({
  event,
  date,
  readOnly,
  onClose,
  onSave,
  onDelete,
}: {
  event: Occurrence | null;
  date: string | null;
  readOnly: boolean;
  onClose: () => void;
  onSave: (fields: Fields, scope: Scope) => Promise<void>;
  onDelete: (scope: Scope) => Promise<void>;
}) {
  const [f, setF] = useState<Fields>(
    event
      ? {
          title: event.title,
          notes: event.notes,
          kind: event.kind,
          start: event.start,
          end: event.end,
          public: event.public,
          done: event.done,
          reminder: event.reminder,
          rule: event.rule,
        }
      : defaultFields(date),
  );
  const [scope, setScope] = useState<Scope>("one");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false);
  const update = (patch: Partial<Fields>) => setF((x) => ({ ...x, ...patch }));
  const start = f.start
    ? f.kind === "timed"
      ? local(f.start)
      : f.start
    : today();
  const end = f.end
    ? f.kind === "timed"
      ? local(f.end)
      : addDays(f.end, -1)
    : today();
  const rule = (patch: Partial<Rule>) =>
    update({ rule: { ...f.rule!, ...patch } });
  const recurring = event?.recurring;
  async function action(deleting = false) {
    setBusy(true);
    setError("");
    try {
      if (deleting) await onDelete(scope);
      else await onSave(validate(f), scope);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function kind(value: Fields["kind"]) {
    const d = start.slice(0, 10);
    update(
      value === "undated"
        ? { kind: value, start: null, end: null, rule: null, reminder: null }
        : value === "all_day"
          ? { kind: value, start: d, end: addDays(d, 1), reminder: -540 }
          : {
              kind: value,
              start: toUTC(`${d}T09:00`),
              end: toUTC(`${d}T10:00`),
              reminder: 10,
            },
    );
  }
  if (readOnly && event)
    return (
      <Modal title="일정 보기" onClose={onClose}>
        <div className="detail">
          <span className="eyebrow">
            공유된 일정 · {event.done ? "완료" : "진행 중"}
          </span>
          <h3>{event.title}</h3>
          <p>
            <Icon name="calendar" />
            {event.kind === "undated"
              ? "날짜 미정"
              : event.kind === "all_day"
                ? `${start} ~ ${end} · 종일`
                : `${start.replace("T", " ")} ~ ${end.replace("T", " ")}`}
          </p>
          <p className="notes">{event.notes || "등록된 메모가 없습니다."}</p>
        </div>
      </Modal>
    );
  return (
    <Modal
      busy={busy}
      title={event ? "일정 편집" : "새로운 할 일"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action();
        }}
      >
        {recurring && (
          <fieldset className="scope">
            <legend>변경 범위</legend>
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
                  name="scope"
                  checked={scope === v}
                  onChange={() => setScope(v)}
                />
                {t}
              </label>
            ))}
          </fieldset>
        )}
        <label>
          제목
          <input
            autoFocus
            required
            maxLength={200}
            placeholder="어떤 일을 계획하고 있나요?"
            value={f.title}
            onChange={(e) => update({ title: e.target.value })}
          />
        </label>
        <label>
          메모
          <textarea
            rows={3}
            maxLength={10000}
            placeholder="기억하고 싶은 내용을 적어 보세요."
            value={f.notes}
            onChange={(e) => update({ notes: e.target.value })}
          />
        </label>
        <label>
          일정 유형
          <select
            aria-label="일정 유형"
            value={f.kind}
            onChange={(e) => kind(e.target.value as Fields["kind"])}
          >
            <option value="undated" disabled={!!recurring}>
              날짜 미정
            </option>
            <option value="all_day">종일</option>
            <option value="timed">시간 지정</option>
          </select>
        </label>
        {f.kind !== "undated" && (
          <>
            <div className="form-row">
              <label>
                시작
                {f.kind === "timed" ? (
                  <input
                    required
                    type="datetime-local"
                    value={start}
                    onChange={(e) => {
                      if (e.target.value)
                        update({ start: toUTC(e.target.value) });
                    }}
                  />
                ) : (
                  <input
                    required
                    type="date"
                    value={start}
                    onChange={(e) => update({ start: e.target.value })}
                  />
                )}
              </label>
              <label>
                종료
                {f.kind === "timed" ? (
                  <input
                    required
                    type="datetime-local"
                    value={end}
                    onChange={(e) => {
                      if (e.target.value)
                        update({ end: toUTC(e.target.value) });
                    }}
                  />
                ) : (
                  <input
                    required
                    type="date"
                    value={end}
                    onChange={(e) => {
                      if (e.target.value)
                        update({ end: addDays(e.target.value, 1) });
                    }}
                  />
                )}
              </label>
            </div>
            <p className="field-hint">
              한국 시간 기준 · 종일 일정은 종료 날짜까지 포함합니다.
            </p>
            <label>
              반복
              <select
                aria-label="반복"
                disabled={!!recurring && scope === "one"}
                value={f.rule?.frequency || "none"}
                onChange={(e) =>
                  update({
                    done: recurring ? f.done : false,
                    rule:
                      e.target.value === "none"
                        ? null
                        : {
                            frequency: e.target.value as Rule["frequency"],
                            interval: 1,
                            weekdays: [weekday(start.slice(0, 10))],
                            monthly: "date",
                            day: Number(start.slice(8, 10)),
                            ordinal: 1,
                            weekday: weekday(start.slice(0, 10)),
                            until: null,
                          },
                  })
                }
              >
                <option value="none">반복 없음</option>
                <option value="daily">매일</option>
                <option value="weekly">매주 · 격주</option>
                <option value="monthly">매월</option>
              </select>
            </label>
            {f.rule && (
              <fieldset
                className="repeat-box"
                disabled={!!recurring && scope === "one"}
              >
                <div className="form-row">
                  <label>
                    반복 간격
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={f.rule.interval}
                      onChange={(e) =>
                        rule({ interval: Number(e.target.value) })
                      }
                    />
                  </label>
                  <span className="unit">
                    {f.rule.frequency === "daily"
                      ? "일"
                      : f.rule.frequency === "weekly"
                        ? "주"
                        : "개월"}
                    마다
                  </span>
                </div>
                {f.rule.frequency === "weekly" && (
                  <div className="weekday-picks">
                    {days.map((d, i) => (
                      <button
                        type="button"
                        key={d}
                        aria-pressed={f.rule!.weekdays.includes(i)}
                        onClick={() =>
                          rule({
                            weekdays: f.rule!.weekdays.includes(i)
                              ? f.rule!.weekdays.filter((w) => w !== i)
                              : [...f.rule!.weekdays, i],
                          })
                        }
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                )}
                {f.rule.frequency === "monthly" && (
                  <>
                    <label>
                      월별 기준
                      <select
                        aria-label="월별 기준"
                        value={f.rule.monthly}
                        onChange={(e) =>
                          rule({ monthly: e.target.value as Rule["monthly"] })
                        }
                      >
                        <option value="date">지정 날짜</option>
                        <option value="last_day">마지막 날</option>
                        <option value="nth_weekday">몇째 / 마지막 요일</option>
                      </select>
                    </label>
                    {f.rule.monthly === "date" && (
                      <label>
                        매월 날짜
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={f.rule.day}
                          onChange={(e) =>
                            rule({ day: Number(e.target.value) })
                          }
                        />
                      </label>
                    )}
                    {f.rule.monthly === "nth_weekday" && (
                      <div className="form-row">
                        <label>
                          순서
                          <select
                            aria-label="순서"
                            value={f.rule.ordinal}
                            onChange={(e) =>
                              rule({ ordinal: Number(e.target.value) })
                            }
                          >
                            {[
                              [1, "첫째"],
                              [2, "둘째"],
                              [3, "셋째"],
                              [4, "넷째"],
                              [5, "다섯째"],
                              [-1, "마지막"],
                            ].map(([v, t]) => (
                              <option value={v} key={v}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          요일
                          <select
                            aria-label="요일"
                            value={f.rule.weekday}
                            onChange={(e) =>
                              rule({ weekday: Number(e.target.value) })
                            }
                          >
                            {days.map((d, i) => (
                              <option value={i} key={i}>
                                {d}요일
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                    <p className="field-hint">
                      해당 날짜나 순서의 요일이 없는 달은 건너뜁니다.
                    </p>
                  </>
                )}
                <label>
                  반복 종료일 <span className="muted">(선택)</span>
                  <input
                    type="date"
                    value={f.rule.until || ""}
                    onChange={(e) => rule({ until: e.target.value || null })}
                  />
                </label>
              </fieldset>
            )}
            <label>
              알림
              <select
                aria-label="알림"
                value={f.reminder === null ? "off" : String(f.reminder)}
                onChange={(e) =>
                  update({
                    reminder:
                      e.target.value === "off" ? null : Number(e.target.value),
                  })
                }
              >
                <option value="off">알림 없음</option>
                {(f.kind === "timed"
                  ? [
                      [0, "시작 시각"],
                      [5, "5분 전"],
                      [10, "10분 전"],
                      [30, "30분 전"],
                      [60, "1시간 전"],
                      [1440, "하루 전"],
                    ]
                  : [
                      [-540, "시작일 오전 9시"],
                      [-480, "시작일 오전 8시"],
                      [-720, "시작일 낮 12시"],
                      [900, "전날 오전 9시"],
                    ]
                ).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <div className="check-row">
          <label>
            <input
              type="checkbox"
              checked={f.public}
              onChange={(e) => update({ public: e.target.checked })}
            />
            <span>
              공유 링크에 공개
              <small>제목, 메모, 일정과 완료 상태가 보입니다.</small>
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={f.done}
              disabled={!!f.rule && (!recurring || scope !== "one")}
              onChange={(e) => update({ done: e.target.checked })}
            />
            완료
          </label>
        </div>
        {f.rule && (!recurring || scope !== "one") && (
          <p className="field-hint">
            완료 여부는 저장한 일정의 각 회차에서 따로 관리합니다.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {confirmDelete ? (
          <div className="delete-confirm">
            <p>
              {recurring
                ? scope === "one"
                  ? "이번 일정"
                  : scope === "future"
                    ? "이번부터 이후 일정"
                    : "전체 반복 일정"
                : "이 일정"}
              을 휴지통으로 이동할까요? 30일간 복구할 수 있습니다.
            </p>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void action(true)}
            >
              삭제하기
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              취소
            </button>
          </div>
        ) : (
          <footer className="form-actions">
            {event && (
              <button
                type="button"
                className="text-button danger-text"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Icon name="trash" />
                삭제
              </button>
            )}
            <div />
            <button type="button" onClick={onClose} disabled={busy}>
              취소
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "저장 중…" : "저장하기"}
            </button>
          </footer>
        )}
      </form>
    </Modal>
  );
}
