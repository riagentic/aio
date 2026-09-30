# Use AIO

- app is built using aio framework (dep/aio, docs in dep/aio/docs)
- aio usage decisions cite dep/aio/docs (feedback file and code comments
  reference concrete doc paths when non-obvious API is used)
- app is using latest aio codebase, API
- aio framework is used correctly
- prefer aio idioms (cells, schedules, persist, testUI) over hand-rolled
  equivalents; deviations carry a comment saying why
- findings about aio go in the file `am feedback <app-name> --create` names —
  NOT in dep/aio/feedback, which belongs to one pinned version, is absent from a
  release, and is deleted by the next `am pin`. `am feedback` prints the path;
  it is outside the version store, so nothing an upgrade does can lose it. What
  belongs there:
  - aio issues found during app development
  - rough edges and anything that made aio difficult to use
  - observations and suggestions for how aio could work better
  - whatever aio could do better, more reliably or more efficiently
- aio `am` is used whenever possible for testing and monitoring , it's way more
  capable and easier to use compared to curl or python approach
- app test coverage is as high as possible and real ui tests for all use cases
  are implemented, executed and running without errors proving perfect app
  functionality
- every aio app has suitable icon
- all errors and failures states within aio app is propery logged and propagated
- aio app uses only official aio logger (no console logs or other logger), all
  logs unified under one log systam and log format
- every aio app that has ui must at boot at least and show ui (ie. no missing ui
  after app boots)
