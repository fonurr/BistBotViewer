# Local bridge utilities

This directory contains the common loopback and same-origin HTTP guard used by both API
boundaries. It validates host/origin, bounds request bodies, applies security headers, and writes
JSON envelopes. It has no routes of its own.

Route ownership stays under `bistApi/server` and `priceApi/server` so upstream and database access
cannot leak into browser modules.
