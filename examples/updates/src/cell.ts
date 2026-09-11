// An ordinary cell. `version` + `onMigrate` are what the published data
// contract is derived from — bump the version without a migration and aio stops
// offering the release to anyone still holding the old shape.
import { cell } from "aio";

export const notes = cell("notes", {
  version: 1,
  state: { items: [] as string[] },
  methods: {
    add(s, text: string) {
      s.items.push(text);
    },
    clear(s) {
      s.items = [];
    },
  },
});
