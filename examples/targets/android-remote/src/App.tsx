// Connect page — user enters the exposed server's URL
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
        <h1>ex-android-remote</h1>
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
