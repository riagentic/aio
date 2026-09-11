// UI — create, edit, delete. Reads cell state reactively, calls cell methods.
// The only async-looking thing here is `await`ing a method so a validation
// failure can be shown; there is no fetch, no store, no transport.
import { useLocal } from "aio/air";
import { type Contact, contacts } from "./cell.ts";

const row: Record<string, string> = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 2fr auto",
  gap: "0.5rem",
  alignItems: "center",
  padding: "0.35rem 0",
};

function Editor() {
  const { local: name, set: setName } = useLocal("");
  const { local: email, set: setEmail } = useLocal("");
  const { local: note, set: setNote } = useLocal("");
  const { local: error, set: setError } = useLocal("");

  const submit = async () => {
    try {
      await contacts.create({ name, email, note });
      setName(""), setEmail(""), setNote(""), setError("");
    } catch (e) {
      // The method threw — the row was never created, and this is why.
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <form t="NewContact" onSubmit={submit} style={row}>
      <input
        placeholder="Name"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <input
        placeholder="Email"
        value={email}
        onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
      />
      <input
        placeholder="Note"
        value={note}
        onInput={(e) => setNote((e.target as HTMLInputElement).value)}
      />
      <button type="submit" t="add">Add</button>
      {error && (
        <div t="error" style={{ gridColumn: "1 / -1", color: "#c33" }}>
          {error}
        </div>
      )}
    </form>
  );
}

function Row({ c }: { c: Contact }) {
  const { local: editing, set: setEditing } = useLocal(false);
  const { local: draft, set: setDraft } = useLocal(c.email);
  const { local: error, set: setError } = useLocal("");

  // The SAME shape as `Editor.submit` above, and for the same reason: a method
  // that refuses does so by throwing, so the caller has to await it to find
  // out. Firing `contacts.update()` unawaited and closing edit mode anyway
  // threw the user's typing away on every refusal — the row snapped back to
  // its old value with no error anywhere, in the example whose subject is
  // validation. Edit mode closes only when the write actually landed.
  const save = async () => {
    try {
      await contacts.update(c.id, { email: draft });
      setError("");
      setEditing(false);
    } catch (e) {
      // Refused — the row is unchanged, the draft is kept, and this is why.
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={row}>
      <span>{c.name}</span>
      {editing
        ? (
          <input
            t="email-edit"
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          />
        )
        : <span>{c.email}</span>}
      <span style={{ color: "#667" }}>
        {error
          ? <span t="row-error" style={{ color: "#c00" }}>{error}</span>
          : c.note}
      </span>
      <span>
        {editing
          ? (
            <button type="button" t={`save-${c.id}`} onClick={save}>
              Save
            </button>
          )
          : (
            <button
              type="button"
              t={`edit-${c.id}`}
              onClick={() => {
                setDraft(c.email); // start from what is on screen now
                setError("");
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
        <button
          type="button"
          t={`delete-${c.id}`}
          onClick={() => contacts.remove(c.id)}
        >
          Delete
        </button>
      </span>
    </div>
  );
}

export default function App() {
  const list = contacts.sorted();
  return (
    <div
      style={{
        maxWidth: 720,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ color: "#00a6cc" }}>Contacts</h1>
      <Editor />
      <div t="Contacts">
        {list.map((c: Contact) => <Row key={c.id} c={c} />)}
      </div>
      {list.length === 0 && <p t="empty">No contacts yet.</p>}
    </div>
  );
}
