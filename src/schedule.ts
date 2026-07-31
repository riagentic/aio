// Public entry — implementation lives in state/schedule.ts.
// Explicit list, not `export *`: the star leaked cron plumbing (parseCron,
// nextCronTime, CronFields) and the runtime manager onto the public surface —
// internals every star-export re-publishes by default.
export {
  isScheduleEffect,
  schedule,
  type ScheduleDef,
  type ScheduleEffect,
} from "./state/schedule.ts";
