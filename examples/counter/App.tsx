// UI component — export default, framework mounts it
import { useFeature } from "aio/air";
import { counter } from "./app.ts";

const btn: Record<string, string> = {
  padding: "0.75rem 1.5rem",
  fontSize: "1.25rem",
  cursor: "pointer",
};

export default function App() {
  const { state, send } = useFeature(counter);
  if (!state) return <div>Connecting...</div>;

  return (
    <div
      style={{
        padding: "3rem",
        fontFamily: "system-ui, sans-serif",
        textAlign: "center",
      }}
    >
      <h1>AIO Counter</h1>
      <div style={{ fontSize: "4rem", margin: "1rem 0", color: "#00a6cc" }}>
        {state.count}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
        <button type="button" onClick={() => send.decrement()} style={btn}>
          −
        </button>
        <button type="button" onClick={() => send.reset()} style={btn}>
          Reset
        </button>
        <button type="button" onClick={() => send.increment()} style={btn}>
          +
        </button>
      </div>
    </div>
  );
}
