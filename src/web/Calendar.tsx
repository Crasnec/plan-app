import { useEffect, useRef, useState } from "react";
import {
  addDays,
  weekday,
  today,
  local,
  toUTC,
  startDate,
  endDate,
  type Occurrence,
} from "../shared/domain.js";
import { timeLayout } from "../shared/layout.js";
import { Icon } from "./icons.js";
export type View = "month" | "week" | "day";
export function range(date: string, view: View) {
  const first = date.slice(0, 7) + "-01";
  const start =
    view === "month"
      ? addDays(first, -weekday(first))
      : view === "week"
        ? addDays(date, -weekday(date))
        : date;
  return {
    from: start,
    to: addDays(start, view === "month" ? 42 : view === "week" ? 7 : 1),
  };
}
export function Calendar({
  date,
  selected,
  view,
  events,
  onSelect,
  onOpen,
  onMove,
  readOnly,
}: {
  date: string;
  selected: string;
  view: View;
  events: Occurrence[];
  onSelect: (d: string) => void;
  onOpen: (e: Occurrence) => void;
  onMove: (
    e: Occurrence,
    start: string,
    end: string,
    resize: boolean,
    kind?: Occurrence["kind"],
  ) => void;
  readOnly: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{
    id: string;
    resize: boolean;
    offset: number;
    anchor: number;
  } | null>(null);
  const [timeTarget, setTimeTarget] = useState<{
    date: string;
    minute: number;
  } | null>(null);
  const [dropDate, setDropDate] = useState<string | null>(null);
  const resetDrag = () => {
    setDragging(null);
    setDropDate(null);
    setTimeTarget(null);
  };
  useEffect(() => {
    window.addEventListener("dragend", resetDrag);
    window.addEventListener("drop", resetDrag);
    window.addEventListener("blur", resetDrag);
    return () => {
      window.removeEventListener("dragend", resetDrag);
      window.removeEventListener("drop", resetDrag);
      window.removeEventListener("blur", resetDrag);
    };
  }, []);
  useEffect(() => setExpandedDate(null), [date, view]);
  const r = range(date, view),
    count = view === "month" ? 42 : view === "week" ? 7 : 1;
  const dates = Array.from({ length: count }, (_, i) => addDays(r.from, i));
  const movable = !readOnly && matchMedia("(pointer:fine)").matches;
  useEffect(() => {
    if (view !== "month" && scroll.current) scroll.current.scrollTop = 7 * 60;
  }, [view]);
  const startDrag = (ev: React.DragEvent, e: Occurrence, resize = false) => {
    if (!movable) {
      ev.preventDefault();
      return;
    }
    ev.stopPropagation();
    const block = (ev.currentTarget as HTMLElement).closest<HTMLElement>(
      ".time-event",
    );
    setDragging({
      id: e.id,
      resize,
      offset:
        block && !resize ? ev.clientY - block.getBoundingClientRect().top : 0,
      anchor: block ? Number.parseFloat(block.style.top) : 0,
    });
    setDropDate(null);
    ev.dataTransfer.setData(
      "application/plan",
      JSON.stringify({ id: e.id, resize }),
    );
    ev.dataTransfer.effectAllowed = "move";
  };
  const targetMinute = (ev: React.DragEvent<HTMLDivElement>) => {
    const position = ev.clientY - ev.currentTarget.getBoundingClientRect().top;
    if (dragging && !dragging.resize)
      return Math.max(
        0,
        Math.min(
          1439,
          dragging.anchor +
            Math.round((position - dragging.offset - dragging.anchor) / 30) *
              30,
        ),
      );
    return Math.max(0, Math.min(1410, Math.floor(position / 30) * 30));
  };
  const activeEvent = dragging && events.find((e) => e.id === dragging.id);
  const timeAt = (d: string, minute: number) =>
    new Date(
      Date.parse(toUTC(`${d}T00:00`)) + Math.round(minute * 60000),
    ).toISOString();
  const targetTime = timeTarget && timeAt(timeTarget.date, timeTarget.minute);
  const previewEnd =
    targetTime && activeEvent
      ? new Date(
          Date.parse(targetTime) +
            (dragging?.resize
              ? 30 * 60000
              : activeEvent.kind === "all_day"
                ? 60 * 60000
                : Date.parse(activeEvent.end!) -
                  Date.parse(activeEvent.start!)),
        ).toISOString()
      : null;
  const drop = (
    ev: React.DragEvent,
    d: string,
    minute?: number,
    allDay = false,
  ) => {
    ev.preventDefault();
    resetDrag();
    if (!movable) return;
    try {
      const payload = JSON.parse(ev.dataTransfer.getData("application/plan"));
      const e = events.find((x) => x.id === payload.id);
      if (!e) return;
      if (e.kind === "all_day" && minute !== undefined) {
        if (payload.resize) return;
        const start = timeAt(d, minute);
        onMove(
          e,
          start,
          new Date(Date.parse(start) + 3600000).toISOString(),
          false,
          "timed",
        );
        return;
      }
      if (e.kind === "timed" && allDay) {
        if (payload.resize) return;
        onMove(e, d, addDays(d, 1), false, "all_day");
        return;
      }
      if (e.kind === "all_day") {
        if (payload.resize) {
          const end = addDays(d, 1);
          if (end > e.start!) onMove(e, e.start!, end, true);
        } else {
          const duration = Math.round(
            (Date.parse(e.end!) - Date.parse(e.start!)) / 86400000,
          );
          onMove(e, d, addDays(d, duration), false);
        }
      } else if (e.kind === "timed") {
        const target =
          minute === undefined
            ? toUTC(`${d}T${local(e.start!).slice(11, 16)}`)
            : timeAt(d, minute);
        if (payload.resize) {
          const end =
            minute === undefined
              ? toUTC(`${d}T${local(e.end!).slice(11, 16)}`)
              : new Date(Date.parse(target) + 30 * 60000).toISOString();
          if (end > e.start!) onMove(e, e.start!, end, true);
        } else
          onMove(
            e,
            target,
            new Date(
              Date.parse(target) + Date.parse(e.end!) - Date.parse(e.start!),
            ).toISOString(),
            false,
          );
      }
    } catch {
      /* Ignore drag data from other applications. */
    }
  };
  const eventButton = (e: Occurrence, small = false) => (
    <div
      className={`calendar-event ${movable ? "is-movable" : ""} ${dragging?.id === e.id ? "is-dragging" : ""} ${e.done ? "is-done" : ""} ${e.public ? "is-public" : ""}`}
      key={e.id}
      draggable={movable}
      onDragStart={(ev) => startDrag(ev, e)}
    >
      <button
        draggable={movable}
        onDragStart={(ev) => startDrag(ev, e)}
        onClick={() => {
          if (!dragging) onOpen(e);
        }}
        title={
          movable ? `${e.title} · 끌어서 날짜 이동, 클릭해서 열기` : e.title
        }
      >
        {movable && (
          <span className="drag-grip" aria-hidden="true">
            ⠿
          </span>
        )}
        {e.kind === "timed" && <span>{local(e.start!).slice(11, 16)}</span>}
        {e.done && <Icon name="check" size={12} />}
        <span className="event-title">{e.title}</span>
      </button>
      {movable && !small && (
        <span
          className="resize-handle"
          title="종료 날짜로 끌어 기간 조절"
          draggable
          onDragStart={(ev) => startDrag(ev, e, true)}
        >
          ⋮
        </span>
      )}
    </div>
  );
  if (view === "month")
    return (
      <div className="month-calendar">
        <div className="weekday-head">
          {["월", "화", "수", "목", "금", "토", "일"].map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div className="month-grid">
          {dates.map((d) => {
            const dayEvents = events.filter(
              (e) =>
                e.kind !== "undated" && startDate(e)! <= d && endDate(e)! >= d,
            );
            return (
              <div
                key={d}
                className={`day-cell ${dropDate === d ? "drop-target" : ""} ${d === selected ? "selected" : ""} ${d.slice(0, 7) !== date.slice(0, 7) ? "outside" : ""}`}
                onDragOver={(e) => {
                  if (
                    movable &&
                    dragging &&
                    e.dataTransfer.types.includes("application/plan")
                  ) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDropDate(d);
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                    setDropDate((current) => (current === d ? null : current));
                }}
                onDrop={(e) => drop(e, d)}
              >
                {dropDate === d && (
                  <span className="drop-label" role="status">
                    {Number(d.slice(5, 7))}/{Number(d.slice(8))}{" "}
                    {dragging?.resize ? "종료일로 변경" : "날짜로 이동"}
                  </span>
                )}
                <button
                  className={`day-number ${d === today() ? "today" : ""}`}
                  aria-label={`${d} 선택`}
                  aria-pressed={d === selected}
                  onClick={() => onSelect(d)}
                >
                  {Number(d.slice(8))}
                </button>
                <div className="day-events" id={`day-events-${d}`}>
                  {(expandedDate === d ? dayEvents : dayEvents.slice(0, 3)).map(
                    (e) => eventButton(e),
                  )}
                  {dayEvents.length > 3 && (
                    <button
                      className="more-events"
                      aria-expanded={expandedDate === d}
                      aria-controls={`day-events-${d}`}
                      onClick={() => {
                        onSelect(d);
                        setExpandedDate((current) =>
                          current === d ? null : d,
                        );
                      }}
                    >
                      {expandedDate === d
                        ? "접기"
                        : `+${dayEvents.length - 3}개 더 보기`}
                    </button>
                  )}
                </div>
                <div className="mobile-dots" aria-hidden="true">
                  {dayEvents.slice(0, 3).map((e) => (
                    <i key={e.id} className={e.done ? "done" : ""} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  return (
    <div className="time-calendar">
      <div
        className="time-days"
        style={{ gridTemplateColumns: `52px repeat(${count},minmax(0,1fr))` }}
      >
        <span className="zone">KST</span>
        {dates.map((d) => (
          <button
            key={d}
            className={d === selected ? "selected" : ""}
            onClick={() => onSelect(d)}
          >
            <span>
              {["월", "화", "수", "목", "금", "토", "일"][weekday(d)]}
            </span>
            <strong className={d === today() ? "today" : ""}>
              {Number(d.slice(8))}
            </strong>
          </button>
        ))}
      </div>
      <div
        className="all-day-row"
        style={{ gridTemplateColumns: `52px repeat(${count},minmax(0,1fr))` }}
      >
        <span>종일</span>
        {dates.map((d) => (
          <div
            key={d}
            className={dropDate === d ? "all-day-target" : ""}
            onDragOver={(e) => {
              if (
                movable &&
                dragging &&
                !dragging.resize &&
                e.dataTransfer.types.includes("application/plan")
              ) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropDate(d);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                setDropDate(null);
            }}
            onDrop={(e) => drop(e, d, undefined, true)}
          >
            {dropDate === d && (
              <small className="all-day-target-label" role="status">
                {Number(d.slice(5, 7))}/{Number(d.slice(8))} 종일로 이동
              </small>
            )}
            {events
              .filter(
                (e) =>
                  e.kind === "all_day" &&
                  startDate(e)! <= d &&
                  endDate(e)! >= d,
              )
              .map((e) => eventButton(e))}
          </div>
        ))}
      </div>
      <div className="time-scroll" ref={scroll}>
        <div
          className="time-body"
          style={{ gridTemplateColumns: `52px repeat(${count},minmax(0,1fr))` }}
        >
          <div className="time-labels">
            {Array.from({ length: 24 }, (_, i) => (
              <span key={i} style={{ top: i * 60 }}>
                {String(i).padStart(2, "0")}:00
              </span>
            ))}
          </div>
          {dates.map((d) => (
            <div
              key={d}
              className="time-column"
              onDragOver={(e) => {
                if (
                  movable &&
                  dragging &&
                  e.dataTransfer.types.includes("application/plan")
                ) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setTimeTarget({ date: d, minute: targetMinute(e) });
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                  setTimeTarget((current) =>
                    current?.date === d ? null : current,
                  );
              }}
              onDrop={(e) => {
                drop(e, d, targetMinute(e));
              }}
            >
              {Array.from({ length: 48 }, (_, i) => (
                <div key={i} className={`time-slot ${i % 2 ? "half" : ""}`} />
              ))}
              {timeLayout(events, d).map((p) => (
                <div
                  key={p.event.id}
                  className={`time-event ${movable ? "is-movable" : ""} ${dragging?.id === p.event.id ? "is-dragging" : ""} ${p.event.done ? "is-done" : ""}`}
                  style={{
                    top: p.top,
                    height: Math.max(18, p.height),
                    left: `${(p.column * 100) / p.columns}%`,
                    width: `${100 / p.columns}%`,
                  }}
                  draggable={movable}
                  onDragStart={(e) => startDrag(e, p.event)}
                >
                  <button
                    draggable={movable}
                    onDragStart={(e) => startDrag(e, p.event)}
                    title="끌어서 시간 이동 · 클릭해서 열기"
                    onClick={() => {
                      if (!dragging) onOpen(p.event);
                    }}
                  >
                    <strong>{p.event.title}</strong>
                    <span>
                      {local(p.event.start!).slice(11, 16)}–
                      {local(p.event.end!).slice(11, 16)}
                    </span>
                  </button>
                  {movable && (
                    <span
                      className="time-resize"
                      draggable
                      title="종료 시간으로 끌어 길이 조절"
                      onDragStart={(e) => startDrag(e, p.event, true)}
                    />
                  )}
                </div>
              ))}
              {timeTarget?.date === d && targetTime && previewEnd && (
                <div
                  className="time-drop-preview"
                  role="status"
                  style={{
                    top: timeTarget.minute,
                    height: Math.max(
                      30,
                      Math.min(
                        1440 - timeTarget.minute,
                        dragging?.resize
                          ? 30
                          : (Date.parse(previewEnd) - Date.parse(targetTime)) /
                              60000,
                      ),
                    ),
                  }}
                >
                  {dragging?.resize ? "종료 " : "이동 "}
                  {dragging?.resize
                    ? local(previewEnd).slice(11, 16)
                    : `${local(targetTime).slice(11, 16)}–${local(previewEnd).slice(11, 16)}`}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
