import type { BoardDrag } from "../hooks/useBoardDrag.ts";

/** A quiet drop zone that only exists while a card is in the air. Dropping here is Not important. */
export function LetGoZone({ drag }: { drag: BoardDrag }) {
  if (!drag.draggingId) return null;
  return (
    <div className="home-dock">
      <div
        className={`let-go-zone${drag.overKey === "let-go" ? " is-over" : ""}`}
        {...drag.target("let-go", { type: "let-go" })}
      >
        <strong>Let go</strong>
        <span>Not important. It won't come back.</span>
      </div>
    </div>
  );
}
