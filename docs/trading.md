## Trading flow

## Entry logic

- new closed bar (N-bar) data are available
- HG evaluates
- if HG signal entry, prepare for entry (no etry yet)
- new closed bar (N+1-bar) data are available
- if (N (closed and locked candle signals entry), enter position ASAP on current
  (N+1) bar (if you passed all gates)
- if (N (closed and locked candle doesn't signal's entry'), don't enter the
  position
