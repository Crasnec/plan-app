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
  onMove: (e: Occurrence, start: string, end: string, resize: boolean) => void;
  readOnly: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  useEffect(() => setExpandedDate(null), [date, view]);
  const r = range(date, view),
    count = view === "month" ? 42 : view === "week" ? 7 : 1;
  const dates = Array.from({ length: count }, (_, i) => addDays(r.from, i));
  const movable = !readOnly && matchMedia("(pointer:fine)").matches;
  useEffect(() => {
    if (view !== "month" && scroll.current) scroll.current.scrollTop = 7 * 60;
  }, [view]);
  const startDrag = (ev: React.DragEvent, e: Occurrence, resize = false) => {
    ev.stopPropagation();
    ev.dataTransfer.setData(
      "application/plan",
      JSON.stringify({ id: e.id, resize }),
    );
    ev.dataTransfer.effectAllowed = "move";
  };
  const drop = (ev: React.DragEvent, d: string, minute?: number) => {
    ev.preventDefault();
    if (!movable) return;
    try {
      const payload = JSON.parse(ev.dataTransfer.getData("application/plan"));
      const e = events.find((x) => x.id === payload.id);
      if (!e) return;
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
        const time =
          minute === undefined
            ? local(e.start!).slice(11, 16)
            : `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        const target = toUTC(`${d}T${time}`);
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
      className={`calendar-event ${e.done ? "is-done" : ""} ${e.public ? "is-public" : ""}`}
      key={e.id}
      draggable={movable}
      onDragStart={(ev) => startDrag(ev, e)}
    >
      <button onClick={() => onOpen(e)} title={e.title}>
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
                className={`day-cell ${d === selected ? "selected" : ""} ${d.slice(0, 7) !== date.slice(0, 7) ? "outside" : ""}`}
                onDragOver={(e) => {
                  if (movable) e.preventDefault();
                }}
                onDrop={(e) => drop(e, d)}
              >
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
            onDragOver={(e) => {
              if (movable) e.preventDefault();
            }}
            onDrop={(e) => drop(e, d)}
          >
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
                if (movable) e.preventDefault();
              }}
              onDrop={(e) => {
                const minute = Math.max(
                  0,
                  Math.min(
                    1410,
                    Math.floor(
                      (e.clientY -
                        e.currentTarget.getBoundingClientRect().top) /
                        30,
                    ) * 30,
                  ),
                );
                drop(e, d, minute);
              }}
            >
              {Array.from({ length: 48 }, (_, i) => (
                <div key={i} className={`time-slot ${i % 2 ? "half" : ""}`} />
              ))}
              {timeLayout(events, d).map((p) => (
                <div
                  key={p.event.id}
                  className={`time-event ${p.event.done ? "is-done" : ""}`}
                  style={{
                    top: p.top,
                    height: Math.max(18, p.height),
                    left: `${(p.column * 100) / p.columns}%`,
                    width: `${100 / p.columns}%`,
                  }}
                  draggable={movable}
                  onDragStart={(e) => startDrag(e, p.event)}
                >
                  <button onClick={() => onOpen(p.event)}>
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
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
