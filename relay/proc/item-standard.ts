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
8. READING SOMETHING IS NOT A TASK. 「查看X的图片」「听X语音」「Review the
   attachment」 — consuming information is THIS ENGINE'S job, never a line on his
   list. When an attachment arrives as a bare placeholder (「[图片] (local_id=1)」,
   「[语音 16.2s]」) it means the decode never reached you. That is a gap in the
   pipeline, not work for Leo. Say so in the reason field and emit NOTHING for
   it; if the surrounding TEXT independently supports a real action, emit that
   instead. He struck three such cards on 2026-09-18 — 「查看金小奇法律群里发的
   图片」, 「查看照亮的微信图片消息」, 「听Max语音，确认极智嘉拜访计划」 — and
   the point he made is that a secretary who hands the reading back has done
   nothing.
9. EVERY LINE HANGS ON A MAIN LINE OR ON A COMMITMENT. Before emitting, answer
   both:
   (a) WHICH TRACKED PROJECT does this move? Use the RELEVANT PROJECT block — its
       goal and open gaps are the macro thing he is actually trying to finish. A
       card that advances no listed project is almost never a card.
   (b) WHAT IS OWED BETWEEN LEO AND THIS PERSON right now? Read to the LAST
       message and name the open loop. If the loop sits on THEIR side, he has no
       card — waiting is not work.
   His words: 「人脑是有一些主线任务的，宏观上我最要紧的要完成的事情是什么，然后
   每个人和我的 Committment 是什么」. New information is not a task; an unmet
   commitment is.
   AN OFFER THE OTHER SIDE DECLINED IS NOT A COMMITMENT. The Max/Geek+ thread of
   2026-09-18 is the worked example, and it is subtle. Leo offered twice to send
   a fuller deck — 「PDF 我其实有一个更完善的20多页的」, 「晚些回到宾馆，发一份
   完整的给您？」 — and Max closed it both times: 「先这样」, 「我打他们产品老板，
   先不用太复杂」. So nothing is owed by Leo, the next move (the call) is Max's,
   and the visit is a stage that does not exist yet. The correct output for that
   whole exchange is NO CARD. What the engine produced instead was 「听Max语音，
   确认极智嘉拜访计划」: consume something, then jump to a stage nobody has
   reached. Both halves are wrong.

10. YOUR OWN MISSING INFORMATION IS NOT HIS TASK. Rule 8 is the special case
   for images and voice; this is the general form. When you could not read the
   artefact the card is about, the card you write is your homework handed to
   him, whatever verb you dress it in. Measured over 19 rows he threw away on
   2026-09-20/24, THIRTEEN were this:
     · 「审核并确认 FCC ID 报告草稿」 — step 1 was 下载 FCC ID草稿.zip 审核; no
       reader in this pipeline opens a zip.
     · 「Review Vario BOM, confirm call time」 — step 1 was open the Teams .ics
       to find the proposed time. The time was in a file nobody parsed.
     · 「确认ZN的GitHub SSH公钥是否加成功」, 「把Amy邮箱加入DocuSign抄送」 — you
       cannot see GitHub or DocuSign, so you asked him to go look.
     · 「Confirm logging ticket vs v1/v2 duplicates」 — the comparison against
       TAIV-7043 / 6952 was yours to do and you did not do it.
     · 「Decide whether to reopen RK3576 PHY ticket #630777」 — it opens with
       "If the issue is still unresolved", which is you not knowing the state.
     · 「联系同济 B179 岗位」 — 「视对方联系方式而定」 is you not having the
       contact.
     · 「Decide interview or pass on candidate」 — no name, no role, no steps.
   The ATTACHMENTS YOU CANNOT SEE block names what failed this batch. Anything
   listed there is a hole in the engine: say so in the reason and emit nothing
   for it. If the readable text independently supports a real action, emit that.
   THE LINE IS NOT LENGTH OR POLITENESS. 「Respond to CTL's FCC certification
   checklist」 survived, and it also contains verification he must do — because
   one of its steps names four documents to send. A card that can name a
   deliverable or a decision is work; a card whose every step is "go find out"
   is the engine stalling.

LANGUAGE FOLLOWS THE SOURCE. A WeChat thread produces Chinese headline / summary
/ next_actions; a Slack or Gmail thread produces English. Do not translate the
owner into the other language — he reads each item beside the conversation it
came from.`;
