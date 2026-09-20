// A card whose whole job is to make Leo consume something the PIPELINE failed
// to read is not a task — it is the engine handing its own failure to him.
//
// WHY A GATE AND NOT A PROMPT RULE: the drafter is already told, in the prompt
// that carries the failure list, "Do NOT emit a card asking Leo to look at,
// open, or listen to these." It emits them anyway. Of the first 10 rows the
// owner threw away with 🚫 这条不该出现, four were exactly this — 查看照亮的微信图片
// 消息, 查看金小奇法律群里发的图片, 听Max语音…, and one whose real content sat inside
// an undecodable screenshot. Instructions did not hold; a deterministic drop does.
//
// Background: the decoder's copy of message_resource.db had been stale since
// June, so EVERY image failed for three months in silence, and "go look at it"
// was the only move the model had left.
//
// DELIBERATELY NARROW. It fires only when the batch really did carry something
// unreadable, and only on a headline that OPENS with a consumption verb AND
// names the medium. "回复温总 FCC 认证进度，附上测试图片" keeps its card: it mentions
// an image but its verb is 回复. The unconditional form of this rule — reading is
// never a task, decode or no decode — is item-standard rule 8's job, enforced by
// the drafter, because a decoded image genuinely can carry the whole point.

/** Opens with a verb that means "consume this". */
const CONSUME_VERB =
  /^\s*(?:查看|查阅|看一下|看看|看|打开|点开|听取|听一下|听|播放|阅读|读|浏览)|^\s*(?:look|open|listen|play|read|review|check|view|watch)\b/i;

/** Names a medium the pipeline decodes — or fails to. */
const MEDIUM =
  /图片|照片|截图|图像|语音|录音|音频|视频|附件|文件|image|photo|screenshot|picture|voice|audio|recording|video|attachment/i;

/**
 * True when this headline is "go consume the thing I could not read".
 *
 * Judged on the HEADLINE only. A step may legitimately say "open the PDF" on
 * the way to real work; the headline is what claims the card exists.
 */
export function isConsumeUnreadableCard(headline: string): boolean {
  const h = (headline ?? "").trim();
  if (h === "") return false;
  return CONSUME_VERB.test(h) && MEDIUM.test(h);
}
