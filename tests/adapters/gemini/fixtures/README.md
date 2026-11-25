# Fixture provenance

All fixture protocol frames and executable behaviors are **synthetic**, modeled on the installed `@google/gemini-cli` 0.56.0 bundle inspected on 2026-11-08. They are not captured model responses. The fake executable implements only version/help, init/message/result and exact-ID resume; environment switches exercise incomplete output and hanging processes. It performs no network or credential operations.

`installed-policy-contract.test.ts` is separately opt-in and imports the installed 0.56.0 policy engine. It exercises actual administrative precedence with synthetic tools and rules, without CLI startup, model inference, auth refresh or session listing. Its bundle filename is deliberately version-specific.

Gemini native IDs in parser fixtures use UUIDs `11111111-1111-4111-8111-111111111111` and `22222222-2222-4222-8222-222222222222`. Error fixtures include the installed 0.56 class-name shapes `ModelNotFoundError`, `ModelUnavailableError`, `FatalAuthenticationError`, `TerminalQuotaError` and `RetryableQuotaError`, plus its stable fatal-authentication exit 41. No real provider output or secrets are included.
