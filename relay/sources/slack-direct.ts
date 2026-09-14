// Direct-API Slack source. Polls the user's conversations via SlackClient
// (relay/io/slack-api.ts), reconstructs the `reply_user_ids` and
// `user_answered_after` + `user_is_last_sender_in_channel` facts that the
// pre-existing slack-channels.normalize() consumes, and emits
// InboundMessage[] ready for the trigger filter.
//
// This is the T-conn replacement path for the Claude-Code-MCP-driven
// slack-channels source. Normalize logic stays in slack-channels.ts —
// this file ONLY does I/O: pull messages, look up replies, compute the
// derived facts, then hand the SlackChannelRaw blob to the existing
// pure normalize().
//
// Cursoring:
//   We use Slack's "ts as oldest" (exclusive) idiom rather than its
//   opaque `cursor` pagination. The marks map in loop-state holds the
//   highest ts seen per channel; next poll passes that as `oldest`. This
//   matches the relay/core/dedup model (per-source lastTimestampMs) and
//   keeps cursor-check, round-commit unchanged.
//
// "Addressed to user" detection:
//   For each batch of channel messages, the poller fetches the latest
//   bottom of the channel to find the most recent sender (→
//   user_is_last_sender_in_channel). For threaded messages, it fetches
//   conversations.replies once per parent ts to gather reply_users and
//   detect whether the user has answered after each candidate. Threading
//   adds 1 API call per parent in the batch; in practice ~0-5 per channel
//   per poll, well under any rate-limit ceiling.

import type { InboundMessage } from "../core/types.js";
import { slackChannelsSource } from "./slack-channels.js";
import type {
  SlackClient,
  SlackConversation,
  SlackHistoryResponse,
  SlackMessage,
} from "../io/slack-api.js";

export interface SlackChannelCursor {
  // Highest slack ts seen for this channel. `oldest` in the next poll.
  // "0" = never polled, full history is "new".
  lastTs: string;
}

export interface SlackPollState {
  // Keyed by channel id. Missing entry = first poll.
  channels: Record<string, SlackChannelCursor>;
}

export interface PolledChannel {
  channel: SlackConversation;
  raw: ChannelRaw;
  newLastTs: string;
}

export interface SlackPollResult {
  selfId: string;
  channels: PolledChannel[];
  // Per-channel failures. A bad channel is isolated here so the channels
  // that DID poll keep their results (and advance their cursors); the
  // caller surfaces these without discarding the successes.
  errors: Array<{ channelId: string; error: string }>;
}

// Shape `slack-channels.normalize()` expects. We keep it inline rather
// than re-exporting from slack-channels.ts so a future tweak there
// doesn't accidentally break our build.
interface ChannelRaw {
  channel_id: string;
  messages: Array<{
    ts: string;
    user: string;
    text: string;
    thread_ts?: string;
    reply_user_ids?: string[];
    user_answered_after?: boolean;
    user_is_last_sender_in_channel?: boolean;
    files?: Array<{ id: string; name?: string; mimetype?: string }>;
  }>;
}

// ─── per-channel poll, deterministic given the API responses ─────────

export interface PollChannelOptions {
  client: SlackClient;
  selfId: string;
  channel: SlackConversation;
  // Previous cursor; "0" or missing means "first ever poll".
  sinceTs?: string;
  // Hard cap on messages fetched per channel per poll. Slack's history
  // page is at most 1000. We default 200 so a multi-day backlog still
  // catches up across a few rounds rather than one mega-fetch.
  perChannelLimit?: number;
}

export async function pollChannel(
  opts: PollChannelOptions,
): Promise<PolledChannel | null> {
  const { client, selfId, channel } = opts;
  const limit = opts.perChannelLimit ?? 200;
  // Empty string / "0" / "0.0" all mean "no prior cursor"; Slack's
  // `oldest=0` returns the full history — fine for a first poll.
  const sinceTs = opts.sinceTs && opts.sinceTs !== "0" ? opts.sinceTs : undefined;

  const page: SlackHistoryResponse = await client.conversationsHistory({
    channel: channel.id,
    oldest: sinceTs,
    limit,
  });
  if (page.messages.length === 0) return null;

  // Slack returns newest first. Process in chronological order for
  // determinism + so `newLastTs` is the max.
  const ordered = [...page.messages].sort((a, b) => Number(a.ts) - Number(b.ts));

  // The newest message in the *whole* channel (not just this page) is
  // the basis for `user_is_last_sender_in_channel`. For an active channel,
  // the newest of the page IS the newest of the channel (we polled to
  // latest). For a quiet channel we'd need a second call; not worth it.
  const newestInBatch = ordered[ordered.length - 1]!;
  const lastSenderIsSelf = newestInBatch.user === selfId;

  // For each parent message that has thread replies in this batch, fetch
  // the full thread once. Tiny pre-pass to dedupe.
  const threadParentTs = new Set<string>();
  for (const m of ordered) {
    if (m.thread_ts && m.thread_ts === m.ts) threadParentTs.add(m.ts);
    if (m.thread_ts && m.thread_ts !== m.ts) threadParentTs.add(m.thread_ts);
    if (!m.thread_ts && m.reply_count && m.reply_count > 0) threadParentTs.add(m.ts);
  }
  const threads = new Map<string, SlackMessage[]>();
  for (const ts of threadParentTs) {
    try {
      const replies = await client.listAllReplies(channel.id, ts);
      threads.set(ts, replies);
    } catch {
      // A thread that's been deleted / inaccessible — skip; treat as
      // empty so the message just doesn't get isReplyInUserThread.
      threads.set(ts, []);
    }
  }

  const messages: ChannelRaw["messages"] = ordered
    .filter((m) => m.user) // drop bot-only / system messages without a user
    .map((m) => {
      const threadTs = m.thread_ts;
      const parentTs = threadTs ?? (threads.has(m.ts) ? m.ts : undefined);
      const replyChain = parentTs ? threads.get(parentTs) ?? [] : [];
      const reply_user_ids = Array.from(
        new Set(replyChain.map((r) => r.user).filter((u): u is string => !!u)),
      );
      // "User answered after THIS message" = user has any reply in the
      // thread with ts > this message's ts.
      const user_answered_after =
        threadTs != null &&
        replyChain.some((r) => r.user === selfId && Number(r.ts) > Number(m.ts));
      return {
        ts: m.ts,
        user: m.user!,
        text: m.text ?? "",
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(reply_user_ids.length > 0 ? { reply_user_ids } : {}),
        ...(user_answered_after ? { user_answered_after } : {}),
        // Same flag value for every msg in this poll: it's a channel-level
        // fact, not a per-msg one. The normalize step is the same shape
        // regardless.
        user_is_last_sender_in_channel: lastSenderIsSelf,
        ...(m.files && m.files.length > 0
          ? {
              files: m.files.map((f) => ({
                id: f.id,
                ...(f.name ? { name: f.name } : {}),
                ...(f.mimetype ? { mimetype: f.mimetype } : {}),
              })),
            }
          : {}),
      };
    });

  return {
    channel,
    raw: { channel_id: channel.id, messages },
    newLastTs: newestInBatch.ts,
  };
}

// ─── multi-channel poll ──────────────────────────────────────────────

export interface PollOptions {
  client: SlackClient;
  // Channels to poll. The source caller decides which set is "relevant"
  // (typically: IMs + MPIMs + channels Leo's a member of). If absent,
  // we list ALL accessible conversations.
  channels?: SlackConversation[];
  // Prior cursors per channel. Missing entries = first poll.
  state?: SlackPollState;
  // Cap per channel. Forwarded to pollChannel.
  perChannelLimit?: number;
}

export async function pollAllChannels(opts: PollOptions): Promise<SlackPollResult> {
  const { client } = opts;
  const auth = await client.authTest();
  const channels = opts.channels ?? (await client.listAllConversations());
  const state = opts.state?.channels ?? {};
  const polled: PolledChannel[] = [];
  const errors: SlackPollResult["errors"] = [];
  for (const channel of channels) {
    if (channel.is_archived) continue;
    const sinceTs = state[channel.id]?.lastTs;
    try {
      const result = await pollChannel({
        client,
        selfId: auth.user_id,
        channel,
        sinceTs,
        perChannelLimit: opts.perChannelLimit,
      });
      if (result) polled.push(result);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      // A 1:1 DM that Slack still lists but whose history 404s is a dead IM
      // (the other party deactivated, or a removed app) — a known Slack quirk,
      // not an actionable fault. Skip it silently like an archived channel;
      // otherwise it re-reports channel_not_found every scan forever. A real
      // channel losing access still surfaces (only is_im is silenced).
      if (channel.is_im && /channel_not_found/.test(msg)) continue;
      // One bad channel mustn't sink the whole poll: record it and move on
      // so every other channel still polls + advances its cursor.
      errors.push({ channelId: channel.id, error: msg });
    }
  }
  return { selfId: auth.user_id, channels: polled, errors };
}

// ─── adapter that produces InboundMessage[] using the existing pure
// normalize from slack-channels.ts ─────────────────────────────────

export function pollResultToInbound(result: SlackPollResult): InboundMessage[] {
  const ctx = { selfSlackId: result.selfId };
  const out: InboundMessage[] = [];
  for (const polled of result.channels) {
    // For 1:1 DMs (is_im) Slack returns is_im=true; for those we want
    // isDirectMessage=true. The existing slack-channels.normalize() hard-
    // codes isDirectMessage=false (it's a channels-mode normalizer), so
    // we patch the field post-normalize when this channel is a DM.
    const msgs = slackChannelsSource.normalize(polled.raw, ctx);
    const isDM = polled.channel.is_im === true;
    const isMPIM = polled.channel.is_mpim === true;
    for (const m of msgs) {
      // Leo's OWN messages are outgoing, never inbound — they must not
      // originate an action item (the "drafted a reply to my own message"
      // bug; mirrors the WeChat `me:`-label exclusion). conversations.history
      // returns both sides; the other side's replies still pass through. The
      // cursor still advances past them (newLastTs), so they don't re-surface.
      if (m.senderHandle === result.selfId) continue;
      if (isDM || isMPIM) {
        m.isDirectMessage = true;
        // For DMs the "addressed to user" question is trivially yes —
        // there's only the two of you. Make sure mentionsUser doesn't
        // need a literal <@self> to count.
        if (isDM) m.mentionsUser = true;
      }
      out.push(m);
    }
  }
  return out;
}

// ─── source registry entry — produces the same shape as slack-channels
// but goes through the SlackClient pipeline. Skill / scan loop calls
// pollAllChannels() then pollResultToInbound(); normalize stays the
// existing pure function. ─────────────────────────────────────────

export interface SlackDirectScan {
  client: SlackClient;
  state?: SlackPollState;
  channels?: SlackConversation[];
  perChannelLimit?: number;
}

export async function scanSlackDirect(opts: SlackDirectScan): Promise<{
  inbound: InboundMessage[];
  nextState: SlackPollState;
  raw: SlackPollResult;
  errors: SlackPollResult["errors"];
}> {
  const raw = await pollAllChannels(opts);
  const inbound = pollResultToInbound(raw);
  const channels: Record<string, SlackChannelCursor> = { ...(opts.state?.channels ?? {}) };
  for (const polled of raw.channels) {
    channels[polled.channel.id] = { lastTs: polled.newLastTs };
  }
  return { inbound, nextState: { channels }, raw, errors: raw.errors };
}

/**
 * When the OWNER last spoke in each of these channels, looking only at or
 * after `sinceMs`. For the answered-closes gate (core/action-item.ts): a card
 * whose whole job was "write back" is finished once he writes back, and on
 * Slack the fact is one conversations.history call away. Only channels with a
 * reply card waiting are asked, on the Slack cadence, so this cannot approach
 * a rate limit. A channel this workspace cannot read (it belongs to the other
 * account) is skipped, not failed.
 */
export async function ownerLastSpokeInChannels(
  client: SlackClient,
  selfId: string,
  channels: readonly string[],
  sinceMs: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // Slack ts is seconds with a fraction; `oldest` is an exclusive lower bound.
  const oldest = (sinceMs / 1000).toFixed(6);
  for (const channel of channels) {
    try {
      const h = await client.conversationsHistory({ channel, oldest, limit: 100 });
      let latest = 0;
      for (const m of h.messages ?? []) {
        if (m.user !== selfId) continue;
        const ms = Math.round(Number(m.ts) * 1000);
        if (ms > latest) latest = ms;
      }
      if (latest > 0) out.set(channel, latest);
    } catch {
      continue;
    }
  }
  return out;
}
