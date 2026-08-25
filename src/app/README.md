# Application runtime

This directory composes shared runtime state:

- `queryClient` is the central, non-persistent server cache.
- `dataHooks` define lazy page reads and price polling.
- `liveUpdates` applies validated MatriksOrder write events to every matching cached selector.
- `ViewerRuntime` owns stream condition, generation-scoped refresh reconciliation, write-event
  buffering, write holds, scroll restoration, logs visibility, and notifications.

Network primitives stay in `bistApi` and `priceApi`; this directory only consumes their typed
interfaces. The BIST boundary journals validated writes around every unresolved table read, so a
lazy query cannot lose an event before its cache exists. Initial connect and reconnect refetch
cached MatriksOrder queries and replay their generation before the stream becomes write-enabled;
upstream SSE itself has neither event ids nor replay.
