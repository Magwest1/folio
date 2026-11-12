import type { CSSProperties } from "react";
import type { BoardLayout } from "../hooks/useBoardLayout.ts";
import type { DayColumn, WeekBoard, WindowBand } from "../model/week-board.ts";
import { BoardCard, type BoardEnv } from "./BoardCard.tsx";

type WeekGridProps = {
  board: WeekBoard;
  env: BoardEnv;
  layout: BoardLayout;
};

function CardList({ entries, env, label }: { entries: DayColumn["entries"]; env: BoardEnv; label?: string }) {
  if (!entries.length) return null;
  return (
    <ul className="week-card-list" role="list" aria-label={label}>
      {entries.map((entry) => (
        <BoardCard key={entry.action.id} entry={entry} env={env} variant="card" />
      ))}
    </ul>
  );
}

function DayColumnView({ day, env }: { day: DayColumn; env: BoardEnv }) {
  const headingId = `week-day-${day.date}`;
  const filled = day.entries.length > 0 || day.earlier.length > 0;
  const key = `day:${day.date}`;
  return (
    <section
      className={[
        "week-day",
        day.isToday && "is-today",
        day.weekend && "is-weekend",
        !filled && "is-empty",
        env.drag.overKey === key && "is-over",
        env.drag.draggingId && "is-target",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-labelledby={headingId}
      data-date={day.date}
      {...env.drag.target(key, { type: "day", date: day.date })}
    >
      <h2 id={headingId} className="week-day-title">
        {day.isToday ? (
          <>
            <span className="week-day-today">Today</span> <span className="week-day-date">{day.label}</span>
          </>
        ) : (
          <span className="week-day-date">{day.label}</span>
        )}
      </h2>
      <div className="week-day-body">
        {day.earlier.map((group) => (
          <div key={group.date} className="week-earlier">
            <p className="week-earlier-label">{group.label}</p>
            <CardList entries={group.entries} env={env} label={`Due ${group.label}`} />
          </div>
        ))}
        {day.earlier.length > 0 && day.entries.length > 0 ? (
          <div className="week-earlier is-today-group">
            <p className="week-earlier-label">today</p>
            <CardList entries={day.entries} env={env} label="Due today" />
          </div>
        ) : (
          <CardList entries={day.entries} env={env} />
        )}
      </div>
    </section>
  );
}

function BandView({ band, env, layout }: { band: WindowBand; env: BoardEnv; layout: BoardLayout }) {
  const headingId = `week-band-${band.key.replace(/\W+/g, "-")}`;
  const style: CSSProperties | undefined =
    layout === "board" ? { gridColumn: `${band.from + 1} / ${band.to + 2}` } : undefined;
  return (
    <section className="week-band" aria-labelledby={headingId} style={style}>
      <h3 id={headingId} className="week-band-label">
        {band.label}
      </h3>
      <ul className="week-chip-list" role="list">
        {band.entries.map((entry) => (
          <BoardCard key={entry.action.id} entry={entry} env={env} variant="chip" />
        ))}
      </ul>
    </section>
  );
}

/** Days across, windows as thin bands above them, and a narrow Later column at the end. */
export function WeekGrid({ board, env, layout }: WeekGridProps) {
  const { later } = board;
  return (
    <div className="week-scroller">
      <div className="week-grid">
        {board.bands.length > 0 && (
          <div className="week-bands">
            {board.bands.map((band) => (
              <BandView key={band.key} band={band} env={env} layout={layout} />
            ))}
          </div>
        )}
        <div className="week-columns">
          {board.days.map((day) => (
            <DayColumnView key={day.date} day={day} env={env} />
          ))}
          <section
            className={[
              "week-day",
              "week-later",
              later.entries.length === 0 && "is-empty",
              env.drag.overKey === "later" && "is-over",
              env.drag.draggingId && "is-target",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-labelledby="week-later-title"
            {...env.drag.target("later", { type: "later" })}
          >
            <h2 id="week-later-title" className="week-day-title">
              <span className="week-day-date">later</span>
            </h2>
            <div className="week-day-body">
              <CardList entries={later.entries} env={env} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
