import type { CSSProperties } from "react";
import type { BoardLayout } from "../hooks/useBoardLayout.ts";
import { targetForColumn } from "../model/board-moves.ts";
import type { BoardEntry, TimeColumn, WeekBoard, WindowBand } from "../model/week-board.ts";
import { BoardCard, type BoardEnv } from "./BoardCard.tsx";

type WeekGridProps = {
  board: WeekBoard;
  env: BoardEnv;
  layout: BoardLayout;
};

function CardList({ entries, env, label }: { entries: BoardEntry[]; env: BoardEnv; label?: string }) {
  if (!entries.length) return null;
  return (
    <ul className="week-card-list" role="list" aria-label={label}>
      {entries.map((entry) => (
        <BoardCard key={entry.action.id} entry={entry} env={env} variant="card" />
      ))}
    </ul>
  );
}

function ColumnView({ column, env }: { column: TimeColumn; env: BoardEnv }) {
  const headingId = `week-col-${column.id.replace(/\W+/g, "-")}`;
  const filled = column.entries.length > 0 || column.earlier.length > 0;
  const key = `col:${column.id}`;
  const crowded = column.earlier.length > 0 && column.entries.length > 0;
  return (
    <section
      className={[
        "week-day",
        `is-${column.kind}`,
        column.isToday && "is-today",
        column.weekend && "is-weekend",
        !filled && "is-empty",
        env.drag.overKey === key && "is-over",
        env.drag.draggingId && "is-target",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-labelledby={headingId}
      data-date={column.start}
      data-end={column.end ?? ""}
      data-column={column.kind}
      {...env.drag.target(key, targetForColumn(column))}
    >
      <h2 id={headingId} className="week-day-title">
        {column.isToday ? (
          <>
            <span className="week-day-today">Today</span> <span className="week-day-date">{column.label}</span>
          </>
        ) : (
          <span className="week-day-date">{column.label}</span>
        )}
      </h2>
      <div className="week-day-body">
        {column.earlier.map((group) => (
          <div key={group.date} className="week-earlier">
            <p className="week-earlier-label">{group.label}</p>
            <CardList entries={group.entries} env={env} label={`Due ${group.label}`} />
          </div>
        ))}
        {crowded ? (
          <div className="week-earlier is-today-group">
            <p className="week-earlier-label">today</p>
            <CardList entries={column.entries} env={env} label="Due today" />
          </div>
        ) : (
          <CardList entries={column.entries} env={env} />
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

/** Wide columns for Today and single days, slimmer ones for the ranges that stand in for empty time. */
function weight(column: TimeColumn): number {
  if (column.isToday) return 1.5;
  if (column.kind === "day") return 1;
  if (column.kind === "later") return 0.7;
  return column.entries.length > 0 ? 0.95 : 0.6;
}

/** Time columns across, windows as thin bands above them. In a narrow pane the same columns are rows. */
export function WeekGrid({ board, env, layout }: WeekGridProps) {
  const template: CSSProperties | undefined =
    layout === "board"
      ? { gridTemplateColumns: board.columns.map((column) => `minmax(0, ${weight(column)}fr)`).join(" ") }
      : undefined;
  return (
    <div className="week-scroller">
      <div className="week-grid">
        {board.bands.length > 0 && (
          <div className="week-bands" style={template}>
            {board.bands.map((band) => (
              <BandView key={band.key} band={band} env={env} layout={layout} />
            ))}
          </div>
        )}
        <div className="week-columns" style={template}>
          {board.columns.map((column) => (
            <ColumnView key={column.id} column={column} env={env} />
          ))}
        </div>
      </div>
    </div>
  );
}
