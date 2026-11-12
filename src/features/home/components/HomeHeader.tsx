import type { HomeGreeting } from "../model/home-greeting.ts";

/** A calm greeting in the app's serif, and one muted line beneath it. */
export function HomeHeader({ greeting }: { greeting: HomeGreeting | null }) {
  return (
    <header className="home-header">
      <h1 className="home-greeting">{greeting?.headline ?? "Hello."}</h1>
      <p className="home-summary" role={greeting?.summary === "Nothing needs you right now." ? "note" : undefined}>
        {greeting?.summary ?? " "}
      </p>
    </header>
  );
}
