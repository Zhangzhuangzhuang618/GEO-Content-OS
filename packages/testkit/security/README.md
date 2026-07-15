# Security test matrix

`security-matrix.json` is the shared, non-production attack corpus for T138. It contains only
benign canary values and is consumed by the API and Web security suites.

Each case has a stable ID, one of the six frozen T138 categories, an attack vector, an input when
needed, and an expected result. A new case must remain deterministic, must not contact an external
service, and must not contain a real credential or customer value.
