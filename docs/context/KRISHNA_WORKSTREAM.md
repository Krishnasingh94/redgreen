# Krishna — Proposed Workstream

This is a proposed split, not a locked assignment. Update it after the project decision.

## Primary ownership
- Backend and data model.
- Runtime capture/replay or other deterministic engineering toolchain.
- Test execution and evidence collection.
- Integration reliability and demo support.

## Suggested tasks
1. Create the backend skeleton and health/status endpoint.
2. Implement the core deterministic workflow selected by the team (for example, parsing a runtime trace, processing a Git diff, invoking tests, or collecting diagnostic data).
3. Define and validate shared API schemas with Samvit.
4. Build a controlled sample application/repository that reliably demonstrates the target failure.
5. Implement safe test execution in an isolated temporary workspace with timeouts and restricted permissions.
6. Add test-result collection, evidence references, and exportable report generation.
7. Add privacy filters for secrets, tokens, cookies, and sensitive request data.
8. Create automated tests and a one-command local setup where practical.

## Deliverables
- Working backend endpoints and shared schemas.
- Deterministic demo fixture with repeatable expected results.
- Safe test/tool execution.
- Automated tests and setup instructions.
- Sample sanitized evidence/report.

## Definition of done
- The demo can be reset and rerun reliably.
- The backend does not treat AI-generated claims as verified facts.
- Commands/tests are not executed with unrestricted host access.
- Timeouts and failures return structured errors.
- Sensitive values are redacted before storage/export.
- Setup instructions work on a clean environment, or limitations are documented.
