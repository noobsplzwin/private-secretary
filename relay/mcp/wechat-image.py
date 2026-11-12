#!/usr/bin/env python3
"""Decode ONE WeChat image message to a file, verified against the message itself.

Run with the wechat-decrypt venv python, cwd = that tool's directory (its config.json):
    python3 wechat-image.py <chat> <local_id> [<create_time>]
Prints one JSON line: {"ok": true, "path", "format", "md5", "via"} or {"ok": false, "error"}.

An image message's XML carries md5= of the DECODED image. A file is returned only
when the md5 of its decoded bytes equals that. Both cheaper answers are wrong
often enough to matter: the tool's message_resource.db lookup takes the newest
row for a local_id, and one chat reuses a local_id up to 7 times; and the
time-nearest .dat can be any picture in the chat.
"""
import glob, hashlib, json, os, re, sqlite3, sys, tempfile

REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr  # the tool's import-time logging must not reach our caller
sys.path.insert(0, os.getcwd())
import mcp_server as w  # noqa: E402  resolve_username, _cache, _image_resolver, image keys
from decode_image import decrypt_dat_file  # noqa: E402


def done(**kw):
    REAL_STDOUT.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.exit(0)


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


chat, local_id = sys.argv[1], int(sys.argv[2])
ts = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] not in ("", "0") else None
username = w.resolve_username(chat) or done(ok=False, error=f"找不到聊天对象: {chat}")

# 1. The message. local_id repeats across message_N.db shards (one chat had it as
#    a text in one shard and an image in another), so require type 3 and, when
#    given, the exact create_time.
rows = []
for match in w._find_msg_tables_for_user(username):
    path, table = match["db_path"], match["table_name"]
    conn = sqlite3.connect(path)
    try:
        for create_time, content, ct in conn.execute(
            f"SELECT create_time, message_content, WCDB_CT_message_content FROM [{table}] "
            "WHERE local_id = ? AND (local_type & 4294967295) = 3",
            (local_id,),
        ):
            if ts is None or create_time == ts:
                rows.append((create_time, w._decompress_content(content, ct) or ""))
    finally:
        conn.close()
if not rows:
    done(ok=False, error=f"{chat} 里没有 local_id={local_id}{f' ts={ts}' if ts else ''} 的图片消息")
if len(rows) > 1:
    done(ok=False, error=f"{chat} 里有 {len(rows)} 条图片消息共用 local_id={local_id}，请同时传 ts 区分")
create_time, xml = rows[0]
m = re.search(r'\bmd5="([0-9a-fA-F]{32})"', xml)
if not m:
    done(ok=False, error="这条图片消息里没有 md5，无法确认是哪张图")
want = m.group(1).lower()
os.makedirs(w.DECODED_IMAGE_DIR, exist_ok=True)

# 2. The tool's own resolver — accepted only if it decoded THIS image.
r = w._image_resolver.decode_image(username, local_id)
if r.get("success") and md5_of(r["path"]) == want:
    done(ok=True, path=r["path"], format=r["format"], md5=want, via="resource-db")

# 3. Every full-size .dat of this chat, nearest in time first (a download lands
#    near the moment it was viewed). Thumbnails (_t) never match the original.
base = os.path.join(w._image_resolver.attach_dir, hashlib.md5(username.encode()).hexdigest())
cands = [p for p in glob.glob(os.path.join(base, "*", "Img", "*.dat")) if not p.endswith("_t.dat")]
cands.sort(key=lambda p: abs(os.path.getmtime(p) - create_time))
for p in cands[:500]:
    fd, tmp = tempfile.mkstemp(suffix=".tmp")
    os.close(fd)
    try:
        res, fmt = decrypt_dat_file(p, tmp, w._image_aes_key, w._image_xor_key)
    except Exception:
        res = None
    if res and md5_of(res) == want:
        final = os.path.join(w.DECODED_IMAGE_DIR, f"{want}.{fmt}")
        os.replace(res, final)
        done(ok=True, path=final, format=fmt, md5=want, via="attach-scan")
    for leftover in {tmp, res}:
        if leftover and os.path.exists(leftover):
            os.unlink(leftover)

done(ok=False, error="本机找不到与这条消息校验一致的原图：多半是这张图没在这台电脑或手机上点开过，本机只有缩略图或什么都没有")
