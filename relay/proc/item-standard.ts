// THE OWNER'S STANDARD for what earns a line in his list. One source of truth,
// shared by the draft and refresh prompts — the two passes that write
// next_actions. Kept apart from either prompt because when it lived in only one
// of them, refresh quietly rewrote cards to a laxer bar on the very next tick.
//
// PROVENANCE: he reviewed a 19-item list item by item and struck out 7 whole
// tasks and most of the steps under several more. Every rule below is one of his
// deletions, in his words where possible. His summary of the whole review:
// "最核心的问题是你加入了很多已经结束的ticket和提醒，跟进，确认这种无意义的ticket".

export const ITEM_STANDARD = `WHAT EARNS A LINE (the owner's own standard, from an item-by-item review in
which he struck 7 of 19 tasks as already finished or never his):

1. ONLY WORK THAT NEEDS LEO'S OWN TIME. If it progresses whether or not he
   touches it, it is not a line and usually not a card. "Ezra is running the
   patch rollout" is Ezra's work — "跟进 X 的进度" on something someone else owns
   is the single most common line he deletes. He cannot chase everything.
2. NO VAGUE VERBS ALONE. 确认 / 核对 / 明确 / 跟进 / follow up / check, with no
   named person and nothing being produced, is not an action — it is a feeling
   that something is unfinished. Name WHO he asks and WHAT he asks for, or drop
   the line. "Ask the supplier to re-check their bank" is not his work.
3. A MEETING IS "约 X 做 Y", NOT "确认时间". If the point is time with someone,
   the line is 约 <person> <purpose> — one line, not a chain of confirm-the-time
   / send-the-invite / sync-afterwards.
4. PINGING NEEDS A REASON. No "ping/催/follow up with X" unless EITHER 7+
   business days have passed with no reply from X, OR his own deadline is close.
   Otherwise the thread is simply in flight and needs nothing from him.
5. WORK THAT COMES LATER IS NOT WORK NOW. Steps that only exist after something
   arrives ("拿到手册后安排 PoC", "收到签署版后归档") belong to the future card.
   Emit what is actionable TODAY.
6. IF THE THREAD ALREADY RESOLVED IT, THERE IS NO CARD. Read to the LAST message
   before deciding. A supplier writing "our finance department has confirmed
   receipt of your payment" closes the payment question; a card saying the wire
   is unconfirmed contradicts the evidence in its own thread.
7. DO NOT INVENT PARTICIPANTS OR ARTEFACTS. Every person, part number, document
   and address in a line must appear in the thread or in the persona files. A
   task about a 200-unit shipment grew steps about V2 boards, a third party and
   a payment schedule that were nowhere in the conversation.

LANGUAGE FOLLOWS THE SOURCE. A WeChat thread produces Chinese headline / summary
/ next_actions; a Slack or Gmail thread produces English. Do not translate the
owner into the other language — he reads each item beside the conversation it
came from.`;
