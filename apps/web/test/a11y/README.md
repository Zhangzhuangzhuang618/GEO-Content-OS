# T140 accessibility acceptance

`pnpm test:a11y` builds the web application and scans the frozen 32 product routes in Chromium. The
suite blocks critical and serious WCAG 2.0/2.1 A/AA axe violations, including automated label and
color-contrast findings. It also checks the skip link, up to six page-contained keyboard stops, visible
focus indicators, disabled-control exclusion, and a unique main landmark. Moving from the final page
control into browser chrome is treated as the end of the page traversal, not as lost page focus.

All network requests are intercepted with deterministic read-only fixtures. Shared tenant, workspace,
project, analytics, and list endpoints return schema-shaped data; unavailable detail resources render
their designed error states. The suite does not connect to a real API or platform and rejects business
writes. Page-specific Playwright tests remain responsible for workflow and populated-state behavior;
automated axe checks do not replace manual assistive-technology acceptance.
