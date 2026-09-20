import { wechatRaw } from "../relay/io/wechat-cli.js";
const out = await wechatRaw("get_chat_history", { chat_name: "58000720981@chatroom", limit: 60 });
console.log(typeof out === "string" ? out : JSON.stringify(out, null, 1));
