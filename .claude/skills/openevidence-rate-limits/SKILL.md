---
name: openevidence-rate-limits
description: Implement OpenEvidence rate limiting, backoff, and request optimization. Use when handling rate limit errors, implementing retry logic, or optimizing API request throughput for clinical queries. Trigger with phrases like "openevidence rate limit", "openevidence throttling", "openevidence 429", "openevidence retry", "openevidence backoff".
allowed-tools: Read, Write, Edit
version: 1.0.0
license: MIT
author: Jeremy Longshore <jeremy@intentsolutions.io>
---

# OpenEvidence Rate Limits

Self-harnessing rate limiter for the OpenEvidence cookie API. Tuned so the
client never bursts above its own configured RPM, even before the server
returns a 429.

## Overview

OpenEvidence does not publish a stable `X-RateLimit-*` contract for the
cookie-based web API. This skill ships a defense-in-depth limiter that:

1. **Sliding-window self-throttle** caps requests-per-window at a configurable
   target usage (default 80% of `maxRequestsPerWindow`).
2. **Hard burst cap** prevents tight loops from firing more than `burstCap`
   requests in any 1-second slice.
3. **Priority queue** — `stat` > `urgent` > `routine` > `research` — so a
   STAT clinical query jumps ahead of a research batch.
4. **Exponential backoff with jitter** on 408/425/429/5xx, with
   `Retry-After` honored verbatim when the server sends it.
5. **Opportunistic header parsing** — if `X-RateLimit-Remaining` /
   `X-RateLimit-Reset` ever appear, they tighten the limiter; otherwise we
   rely on the client-side counters.

The limiter is fully testable: clock and sleeper are injectable so the test
suite runs in ~1 second.

## Implementation map

| File | Role |
| --- | --- |
| `src/rate-limit.ts` | `RateLimitController`, `withExponentialBackoff`, `computeBackoffDelay`, `parseRetryAfterMs`, `HttpError`. |
| `src/openevidence-client.ts` | `requestWithRateLimit` wraps every fetch with `acquire/observe/release` + retry. |
| `src/config.ts` | `resolveRateLimitConfig` reads env vars and folds them into `AppConfig.rateLimit`. |
| `src/types.ts` | `OpenEvidenceAskRequest.priority?: ClinicalPriority`. |
| `test/rate-limit.test.ts` | 25 tests including a 50-concurrent burst integration test. |

## Configuration (env vars)

| Variable | Default | Effect |
| --- | --- | --- |
| `OE_MCP_RPM` | 60 | Max requests per window (typically 1 min). |
| `OE_MCP_RATE_WINDOW_MS` | 60000 | Sliding-window length. |
| `OE_MCP_BURST` | 6 | Hard cap per 1 s slice. |
| `OE_MCP_RATE_TARGET` | 80 | Throttle when usage hits this % of RPM. |
| `OE_MCP_MAX_CONCURRENT` | 4 | In-flight request cap. |
| `OE_MCP_MAX_RETRIES` | 5 | Total retries on 429/5xx. |
| `OE_MCP_RETRY_BASE_MS` | 1000 | Backoff base — `base * 2^attempt`. |
| `OE_MCP_RETRY_MAX_MS` | 60000 | Backoff ceiling. |
| `OE_MCP_RETRY_JITTER_MS` | 500 | Uniform jitter added to backoff. |

Conservative production preset (single small practice):

```bash
export OE_MCP_RPM=30
export OE_MCP_BURST=3
export OE_MCP_RATE_TARGET=70
export OE_MCP_MAX_CONCURRENT=2
```

## Using priorities from MCP tool calls

The `oe_ask` tool accepts an optional priority — set it when wiring clinical
contexts:

```jsonc
{
  "name": "oe_ask",
  "arguments": {
    "question": "Contraindications for tPA in acute ischemic stroke?",
    "priority": "stat"
  }
}
```

`stat` and `urgent` requests bypass any queued `routine` / `research`
acquirers but still respect the sliding window — they cannot burst past the
configured RPM.

## Inspecting state

```ts
const client = new OpenEvidenceClient(resolveConfig());
await client.init();
// ...issue a few requests
console.log(client.getRateLimitMetrics());
// {
//   requestsInWindow: 12, usagePercent: 20, headroom: 48,
//   active: 1, queued: { stat: 0, urgent: 0, routine: 0, research: 0 },
//   serverRemaining: null, serverResetAt: null, retryAfterUntil: null
// }
```

Surface this via a `/health/openevidence` endpoint if running behind HTTP.

## Algorithm cheat sheet

```
acquire(priority):
  if higher-priority queues non-empty OR active >= maxConcurrent:
    park in queues[priority]            # FIFO within priority
  loop:
    wait = max(
      retryAfterUntilMs - now,           # honor server Retry-After
      serverResetMs - now (if remaining=0),
      burstCap window relief,            # <= burstCap per 1s
      sliding window relief,             # <= targetUsage% of RPM
    )
    if wait <= 0: break
    sleep(wait)
  record now in requestTimes
```

`release()` hands the concurrency slot directly to the next priority
waiter — slots are never momentarily free if work is pending, which avoids
a thundering herd.

## Testing

`pnpm run test` runs all suites (citations + rate-limit). Notable cases:

- `withExponentialBackoff: retries on 429 then succeeds` — happy retry path.
- `withExponentialBackoff: surfaces non-retryable 4xx immediately` — 403
  short-circuits without burning attempts.
- `RateLimitController: maxConcurrent + priority ordering` — proves a
  released slot goes to `stat` even when `routine` queued first.
- `RateLimitController.observe: Retry-After header blocks acquire` —
  server-driven backoff wins over local counters.
- `integration: self-harness never exceeds RPM under burst` — 50
  concurrent acquires; assert no 1-second window exceeds the cap.

## Failure modes & remedies

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Many 429s despite throttle | OE tightened cap | Lower `OE_MCP_RPM` / `OE_MCP_RATE_TARGET`. |
| Long stalls on `oe_ask` | A previous 429 with no `Retry-After` set a 2× base backoff. | Wait, or shrink `OE_MCP_RETRY_BASE_MS`. |
| `stat` requests still queued | Concurrency saturated by long-running `routine`. | Bump `OE_MCP_MAX_CONCURRENT` or move `routine` to `research`. |
| Tests hang | Real `setTimeout` instead of injected clock. | Pass the `fakeClock` from `test/rate-limit.test.ts`. |

## Related

- Cookie-based auth lives in `src/cookies.ts` — not affected by this skill.
- Crossref retries are independent and still use their own simple backoff.
- For a portable (Python stdlib) variant of the MCP itself, see
  `openevidence-skill/SKILL.md`.
