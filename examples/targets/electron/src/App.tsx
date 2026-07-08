// UI component — export default, framework mounts it
import { counter } from "./cell/counter.ts";

export default function App() {
  return (
    <div
      style={{
        padding: "3rem",
        fontFamily: "system-ui, sans-serif",
        textAlign: "center",
      }}
    >
      <h1>ex-electron</h1>
      <div style={{ fontSize: "4rem", margin: "1rem 0", color: "#00a6cc" }}>
        {counter.count}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
        <button type="button" onClick={() => counter.decrement()}>−</button>
        <button type="button" onClick={() => counter.reset()}>Reset</button>
        <button type="button" onClick={() => counter.increment()}>+</button>
      </div>
    </div>
  );
}
