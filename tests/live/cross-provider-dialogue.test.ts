import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/index.js';
import type { AgentOptions } from '../../src/index.js';

/**
 * Two agents on two different providers holding one moderated conversation.
 *
 * The orchestrator runs on Codex (gpt-5.6-sol) and the participant on Claude
 * (opus-5). The orchestrator sets the topic, reads what the participant said,
 * challenges it, and closes with a verdict — so the test proves the thing the
 * runtime actually claims: an application can compose agents across providers,
 * each keeping its own native multi-turn session, with text flowing between
 * them. Composition lives in this file, not in the SDK (design spec §16).
 *
 * Cost gate: this burns roughly five model turns across two subscriptions, so
 * it needs OAR_LIVE_TURNS=1 on top of OAR_LIVE=1. `npm run test:live` only
 * sets the former, which leaves this test skipped unless it is asked for by
 * name — the convention the implementation plan §5 describes.
 */
const enabled = process.env.OAR_LIVE === '1' && process.env.OAR_LIVE_TURNS === '1';

// Codex exec has no developer-instruction channel (buildCodexExecArgs refuses
// `instructions` rather than pretending a prefixed user prompt is equivalent),
// so the orchestrator carries its role in the prompt. Claude accepts a real
// system prompt, and the participant uses it — the asymmetry is the point.
const orchestrator: AgentOptions = {
  model: 'gpt-5.6-sol',
  context: { profile: 'clean', memory: 'off' },
  permissions: { mode: 'analyze', strict: false },
  requireAuth: 'subscription',
};

const participant: AgentOptions = {
  model: 'opus-5',
  context: { profile: 'clean', memory: 'off' },
  permissions: { mode: 'analyze' },
  requireAuth: 'subscription',
  instructions:
    'You are a debate participant. Answer in at most three sentences. '
    + 'When asked to include a marker verbatim, reproduce it exactly.',
};

const MODERATOR_ROLE =
  'You are moderating a short technical debate. Reply with JSON only, no prose outside it.';

describe.runIf(enabled).sequential('cross-provider moderated dialogue', () => {
  it('carries a topic from a Codex orchestrator to a Claude participant and back', async () => {
    // The marker is minted here, spoken by Claude, and must come back out of
    // Codex's structured output. That round trip is the actual assertion: no
    // shared memory, no SDK-side relay — only text the application passed.
    const marker = `OAR-${randomUUID().slice(0, 8).toUpperCase()}`;

    const moderator = await new Agent(orchestrator).openSession();
    const debater = await new Agent(participant).openSession();

    try {
      // 1. The orchestrator chooses the topic and opens the exchange.
      const opening = await moderator.send(
        `${MODERATOR_ROLE} Choose one narrow, concrete debate topic about software engineering `
        + 'and write the opening question you would put to a participant. '
        + 'Return {"topic": string, "question": string}.',
        {
          outputSchema: {
            type: 'object',
            properties: { topic: { type: 'string' }, question: { type: 'string' } },
            required: ['topic', 'question'],
            additionalProperties: false,
          },
          timeoutMs: 180_000,
        },
      );
      const round = opening.output as { topic: string; question: string };

      expect(round.topic.length).toBeGreaterThan(0);
      expect(round.question.length).toBeGreaterThan(0);
      console.info(`[codex/moderator] topic: ${round.topic}`);
      console.info(`[codex/moderator] opening: ${round.question}`);

      // 2. The participant answers, tagging its reply so the next hop is provable.
      const answer = await debater.send(
        `Topic: ${round.topic}\nQuestion: ${round.question}\n\n`
        + `Answer it, and end your reply with this marker on its own line: ${marker}`,
        { timeoutMs: 180_000 },
      );

      expect(answer.text).toContain(marker);
      console.info(`[claude/participant] ${answer.text.replace(marker, '').trim()}`);

      // 3. The orchestrator reads the reply and moderates. Echoing the marker
      //    it found proves the participant's words reached the other provider.
      const moderation = await moderator.send(
        `${MODERATOR_ROLE} The participant replied:\n\n"""\n${answer.text}\n"""\n\n`
        + 'Copy the marker token you find in that reply into "observedMarker", '
        + 'and write one challenging follow-up question about the same topic. '
        + 'Return {"observedMarker": string, "followUp": string}.',
        {
          outputSchema: {
            type: 'object',
            properties: { observedMarker: { type: 'string' }, followUp: { type: 'string' } },
            required: ['observedMarker', 'followUp'],
            additionalProperties: false,
          },
          timeoutMs: 180_000,
        },
      );
      const challenge = moderation.output as { observedMarker: string; followUp: string };

      expect(challenge.observedMarker).toBe(marker);
      expect(challenge.followUp.length).toBeGreaterThan(0);
      console.info(`[codex/moderator] marker round-tripped: ${challenge.observedMarker}`);
      console.info(`[codex/moderator] follow-up: ${challenge.followUp}`);

      // 4. The participant answers the follow-up on its own native session, so
      //    it still has the first exchange in context.
      const rebuttal = await debater.send(
        `${challenge.followUp}\n\nAnswer it, then restate in one clause what you argued before.`,
        { timeoutMs: 180_000 },
      );

      expect(rebuttal.text.length).toBeGreaterThan(0);
      console.info(`[claude/participant] ${rebuttal.text.trim()}`);

      // 5. The orchestrator closes with a verdict over the whole exchange.
      const closing = await moderator.send(
        `${MODERATOR_ROLE} The participant answered your follow-up:\n\n"""\n${rebuttal.text}\n"""\n\n`
        + 'Return {"verdict": string, "participantAnsweredFollowUp": boolean, "exchanges": number} '
        + 'where exchanges counts the participant replies you have seen.',
        {
          outputSchema: {
            type: 'object',
            properties: {
              verdict: { type: 'string' },
              participantAnsweredFollowUp: { type: 'boolean' },
              exchanges: { type: 'number' },
            },
            required: ['verdict', 'participantAnsweredFollowUp', 'exchanges'],
            additionalProperties: false,
          },
          timeoutMs: 180_000,
        },
      );
      const verdict = closing.output as {
        verdict: string;
        participantAnsweredFollowUp: boolean;
        exchanges: number;
      };

      console.info(`[codex/moderator] verdict: ${verdict.verdict}`);
      expect(verdict.verdict.length).toBeGreaterThan(0);
      expect(verdict.participantAnsweredFollowUp).toBe(true);
      expect(verdict.exchanges).toBeGreaterThanOrEqual(2);

      // Each side held one native session across all of its turns, on its own
      // provider: three moderator turns and two participant turns, never mixed.
      expect(moderator.ref?.provider).toBe('codex');
      expect(debater.ref?.provider).toBe('claude');
      expect(moderator.ref?.id).not.toBe(debater.ref?.id);
      expect(opening.session.id).toBe(closing.session.id);
      expect(answer.session.id).toBe(rebuttal.session.id);
    } finally {
      await moderator.close().catch(() => undefined);
      await debater.close().catch(() => undefined);
    }
  }, 900_000);
});
