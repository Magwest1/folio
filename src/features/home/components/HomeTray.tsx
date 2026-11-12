import type { BoardEntry, WeekBoard } from "../model/week-board.ts";
import { BoardCard, type BoardEnv } from "./BoardCard.tsx";

type HomeTrayProps = {
  board: WeekBoard;
  env: BoardEnv;
};

function Lane({
  id,
  title,
  entries,
  env,
  className,
  dropKey,
}: {
  id: string;
  title: string;
  entries: BoardEntry[];
  env: BoardEnv;
  className: string;
  dropKey?: "loose";
}) {
  const over = dropKey && env.drag.overKey === dropKey;
  const drop = dropKey ? env.drag.target(dropKey, { type: "loose" }) : {};
  return (
    <section
      className={[
        "tray-lane",
        className,
        dropKey && env.drag.draggingId && "is-target",
        over && "is-over",
        entries.length === 0 && "is-empty",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-labelledby={`tray-${id}`}
      {...drop}
    >
      <h2 id={`tray-${id}`} className="tray-title">
        {title}
      </h2>
      <ul className="tray-chips" role="list">
        {entries.map((entry) => (
          <BoardCard key={entry.action.id} entry={entry} env={env} variant="chip" />
        ))}
      </ul>
    </section>
  );
}

/** Undated things, the ones waiting on others, and what has quietly faded. */
export function HomeTray({ board, env }: HomeTrayProps) {
  return (
    <div className="home-tray">
      {board.toConfirm.length > 0 && (
        <Lane id="to-confirm" title="to confirm" entries={board.toConfirm} env={env} className="is-to-confirm" />
      )}
      <Lane id="loose" title="loose ends" entries={board.looseEnds} env={env} className="is-loose" dropKey="loose" />
      {board.waiting.length > 0 && (
        <Lane id="waiting" title="waiting on others" entries={board.waiting} env={env} className="is-waiting" />
      )}
      {board.faded.length > 0 && (
        <details className="tray-faded">
          <summary>faded</summary>
          <ul className="tray-chips" role="list">
            {board.faded.map((entry) => (
              <BoardCard key={entry.action.id} entry={entry} env={env} variant="chip" />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
