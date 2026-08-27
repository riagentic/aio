// Connect page — user enters the exposed server's URL.
//
// A thin client has no local UI beyond this: the server it connects to serves
// the real one. This file existing is the whole difference between a window
// that asks for an address and a window that renders nothing at all — the
// framework shell imports `/App.tsx`, so without it the page 404s on its own
// mount and the client can never start. Its twin (the other `*-remote` target)
// is the SAME page in another shell; tests/examples-lint.test.ts keeps them
// byte-identical apart from the app name.
import { useLocal } from "aio/air";

export default function App() {
  const { local: url, set: setUrl } = useLocal("");

  const connect = () => {
    const target = url.trim();
    if (target) globalThis.location.href = target;
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontFamily: "system-ui",
      }}
    >
      <div
        style={{
          textAlign: "center",
          padding: "2rem",
          width: "90%",
          maxWidth: "400px",
        }}
      >
        <h1>ex-electron-remote</h1>
        <input
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
          placeholder="http://server:8000"
          style={{
            width: "100%",
            padding: ".8rem 1rem",
            marginBottom: ".8rem",
          }}
        />
        <button
          type="button"
          onClick={connect}
          style={{ width: "100%", padding: ".8rem" }}
        >
          Connect
        </button>
      </div>
    </div>
  );
}
